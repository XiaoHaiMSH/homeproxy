/*
 * SPDX-License-Identifier: GPL-2.0-only
 *
 * Copyright (C) 2022-2025 ImmortalWrt.org
 */

'use strict';
'require form';
'require network';
'require poll';
'require rpc';
'require uci';
'require validation';
'require view';

'require homeproxy as hp';
'require tools.firewall as fwtool';
'require tools.widgets as widgets';

const callServiceList = rpc.declare({
	object: 'service',
	method: 'list',
	params: ['name'],
	expect: { '': {} }
});

const callReadDomainList = rpc.declare({
	object: 'luci.homeproxy',
	method: 'acllist_read',
	params: ['type'],
	expect: { '': {} }
});

const callWriteDomainList = rpc.declare({
	object: 'luci.homeproxy',
	method: 'acllist_write',
	params: ['type', 'content'],
	expect: { '': {} }
});

const callCurrentNode = rpc.declare({
	object: 'luci.homeproxy',
	method: 'current_node_get',
	expect: { '': {} }
});

function getServiceStatus() {
	return L.resolveDefault(callServiceList('homeproxy'), {}).then((res) => {
		let isRunning = false;
		try {
			isRunning = res['homeproxy']['instances']['sing-box-c']['running'];
		} catch (e) { }
		return isRunning;
	});
}

function renderStatus(isRunning, version, node) {
	let spanTemp = '<em><span style="color:%s"><strong>%s (sing-box v%s) %s</strong></span></em>';
	let renderHTML;
	if (isRunning)
		renderHTML = spanTemp.format('green', _('HomeProxy'), version, _('RUNNING'));
	else
		renderHTML = spanTemp.format('red', _('HomeProxy'), version, _('NOT RUNNING'));

	if (!isRunning || !node || !node.active)
		return renderHTML;

	const delay = (node.delay && node.delay !== '-') ? ' (%h)'.format(node.delay) : '';
	renderHTML += '<br/><span style="font-size:0.9em">%s: <strong>%h</strong>%s</span>'
		.format(_('Current node'), node.active.label, delay);

	return renderHTML;
}

let stubValidator = {
	factory: validation,
	apply(type, value, args) {
		if (value != null)
			this.value = value;

		return validation.types[type].apply(this, args);
	},
	assert(condition) {
		return !!condition;
	}
};

return view.extend({
	load() {
		return Promise.all([
			uci.load('homeproxy'),
			hp.getBuiltinFeatures(),
			network.getHostHints()
		]);
	},

	render(data) {
		let m, s, o, ss, so;

		let features = data[1],
		    hosts = data[2]?.hosts;

		function validateDnsFallback(section_id, value) {
			if (!value)
				return true;

			let ipv6_support = this.section.formvalue(section_id, 'ipv6_support');
			try {
				let url = new URL(value.replace(/^.*:\/\//, 'http://'));
				if (stubValidator.apply('hostname', url.hostname))
					return true;
				else if (stubValidator.apply('ip4addr', url.hostname))
					return true;
				else if ((ipv6_support === '1') && stubValidator.apply('ip6addr', url.hostname.match(/^\[(.+)\]$/)?.[1]))
					return true;
				else
					return _('Expecting: %s').format(_('valid DNS server address'));
			} catch (e) {}

			if (!stubValidator.apply((ipv6_support === '1') ? 'ipaddr' : 'ip4addr', value))
				return _('Expecting: %s').format(_('valid DNS server address'));

			return true;
		}

		/* Cache all configured proxy nodes, they will be called multiple times */
		let proxy_nodes = {};
		uci.sections(data[0], 'node', (res) => {
			let nodeaddr = ((res.type === 'direct') ? res.override_address : res.address) || '',
			    nodeport = ((res.type === 'direct') ? res.override_port : res.port) || '';

			proxy_nodes[res['.name']] =
				String.format('[%s] %s', res.type, res.label || ((stubValidator.apply('ip6addr', nodeaddr) ?
					String.format('[%s]', nodeaddr) : nodeaddr) + ':' + nodeport));
		});

		m = new form.Map('homeproxy', _('HomeProxy'),
			_('The modern ImmortalWrt proxy platform for ARM64/AMD64.'));

		s = m.section(form.TypedSection);
		s.render = function () {
			let lastNodeFetch = 0, cachedNode = {};

			const getCurrentNode = () => {
				/* the API query spawns a process, do not run it every poll tick */
				if (Date.now() - lastNodeFetch < 10000)
					return Promise.resolve(cachedNode);
				lastNodeFetch = Date.now();
				return L.resolveDefault(callCurrentNode(), {}).then((res) => {
					cachedNode = res;
					return res;
				});
			};

			poll.add(function () {
				return Promise.all([
					L.resolveDefault(getServiceStatus(), {}),
					getCurrentNode()
				]).then((res) => {
					let view = document.getElementById('service_status');
					view.innerHTML = renderStatus(res[0], features.version, res[1]);
				});
			});

			return E('div', { class: 'cbi-section', id: 'status_bar' }, [
					E('p', { id: 'service_status' }, _('Collecting data...'))
			]);
		}

		s = m.section(form.NamedSection, 'config', 'homeproxy');

		s.tab('routing', _('Routing Settings'));
		s.tab('dns', _('DNS Settings'));

		o = s.taboption('routing', form.ListValue, 'main_node', _('Main node'));
		o.value('nil', _('Disable'));
		o.value('urltest', _('URLTest'));
		for (let i in proxy_nodes)
			o.value(i, proxy_nodes[i]);
		o.default = 'nil';
		o.rmempty = false;
		o.retain = true;

		o = s.taboption('routing', hp.CBIStaticList, 'main_urltest_nodes', _('URLTest nodes'),
			_('List of nodes to test.'));
		for (let i in proxy_nodes)
			o.value(i, proxy_nodes[i]);
		o.depends('main_node', 'urltest');
		o.rmempty = false;

		o = s.taboption('routing', form.Value, 'main_urltest_interval', _('Test interval'),
			_('The test interval in seconds.'));
		o.datatype = 'uinteger';
		o.placeholder = '180';
		o.depends('main_node', 'urltest');

		o = s.taboption('routing', form.Value, 'main_urltest_tolerance', _('Test tolerance'),
			_('The test tolerance in milliseconds.'));
		o.datatype = 'uinteger';
		o.placeholder = '50';
		o.depends('main_node', 'urltest');

		o = s.taboption('dns', form.Value, 'dns_server', _('DNS server'),
			_('Support UDP, TCP, DoH, DoQ, DoT. TCP protocol will be used if not specified.'));
		o.value('wan', _('WAN DNS (read from interface)'));
		o.value('1.1.1.1', _('CloudFlare Public DNS (1.1.1.1)'));
		o.value('208.67.222.222', _('Cisco Public DNS (208.67.222.222)'));
		o.value('8.8.8.8', _('Google Public DNS (8.8.8.8)'));
		o.value('', '---');
		o.value('223.5.5.5', _('Aliyun Public DNS (223.5.5.5)'));
		o.value('119.29.29.29', _('Tencent Public DNS (119.29.29.29)'));
		o.value('117.50.10.10', _('ThreatBook Public DNS (117.50.10.10)'));
		o.default = '8.8.8.8';
		o.rmempty = false;
		o.validate = function(section_id, value) {
			if (section_id && !['wan'].includes(value)) {
				if (!value)
					return _('Expecting: %s').format(_('non-empty value'));

				let ipv6_support = this.section.formvalue(section_id, 'ipv6_support');
				try {
					let url = new URL(value.replace(/^.*:\/\//, 'http://'));
					if (stubValidator.apply('hostname', url.hostname))
						return true;
					else if (stubValidator.apply('ip4addr', url.hostname))
						return true;
					else if ((ipv6_support === '1') && stubValidator.apply('ip6addr', url.hostname.match(/^\[(.+)\]$/)?.[1]))
						return true;
					else
						return _('Expecting: %s').format(_('valid DNS server address'));
				} catch(e) {}

				if (!stubValidator.apply((ipv6_support === '1') ? 'ipaddr' : 'ip4addr', value))
					return _('Expecting: %s').format(_('valid DNS server address'));
			}

			return true;
		}

		o = s.taboption('dns', form.Value, 'china_dns_server', _('China DNS server'),
			_('The dns server for resolving China domains. Support UDP, TCP, DoH, DoQ, DoT.'));
		o.value('wan', _('WAN DNS (read from interface)'));
		o.value('223.5.5.5', _('Aliyun Public DNS (223.5.5.5)'));
		o.value('210.2.4.8', _('CNNIC Public DNS (210.2.4.8)'));
		o.value('119.29.29.29', _('Tencent Public DNS (119.29.29.29)'));
		o.value('117.50.10.10', _('ThreatBook Public DNS (117.50.10.10)'));
		o.depends('routing_mode', 'bypass_mainland_china');
		o.default = '223.5.5.5';
		o.rmempty = false;
		o.validate = function(section_id, value) {
			if (section_id && !['wan'].includes(value)) {
				if (!value)
					return _('Expecting: %s').format(_('non-empty value'));

				try {
					let url = new URL(value.replace(/^.*:\/\//, 'http://'));
					if (stubValidator.apply('hostname', url.hostname))
						return true;
					else if (stubValidator.apply('ip4addr', url.hostname))
						return true;
					else if (stubValidator.apply('ip6addr', url.hostname.match(/^\[(.+)\]$/)?.[1]))
						return true;
					else
						return _('Expecting: %s').format(_('valid DNS server address'));
				} catch(e) {}

				if (!stubValidator.apply('ipaddr', value))
					return _('Expecting: %s').format(_('valid DNS server address'));
			}

			return true;
		}

		o = s.taboption('dns', form.DynamicList, 'dns_server_fallback', _('DNS server (fallback)'),
			_('Additional DNS servers used together with the primary DNS server above. When set, queries are distributed across all of them according to the strategy below. Support UDP, TCP, DoH, DoQ, DoT.'));
		o.retain = true;
		o.validate = validateDnsFallback;

		o = s.taboption('dns', form.DynamicList, 'china_dns_server_fallback', _('China DNS server (fallback)'),
			_('Additional DNS servers used together with the China DNS server above.'));
		o.depends('routing_mode', 'bypass_mainland_china');
		o.retain = true;
		o.validate = validateDnsFallback;

		o = s.taboption('dns', form.ListValue, 'dns_fallback_strategy', _('DNS fallback strategy'),
			_('How to query the primary and fallback DNS servers when fallback servers are configured above.'));
		o.value('sequential', _('Sequential (try in order)'));
		o.value('parallel', _('Parallel (query all at once)'));
		o.default = 'sequential';
		o.rmempty = false;

		o = s.taboption('dns', form.Value, 'dns_fallback_timeout', _('DNS fallback timeout'),
			_('Overall time budget for the whole fallback exchange, in seconds. Leave empty for default (10s).'));
		o.datatype = 'uinteger';
		o.placeholder = '10';

		o = s.taboption('routing', form.ListValue, 'routing_mode', _('Routing mode'));
		o.value('gfwlist', _('GFWList'));
		o.value('bypass_mainland_china', _('Bypass mainland China'));
		o.value('global', _('Global'));
		o.default = 'bypass_mainland_china';
		o.rmempty = false;

		o = s.taboption('routing', form.Value, 'routing_port', _('Routing ports'),
			_('Specify target ports to be proxied. Multiple ports must be separated by commas.'));
		o.value('', _('All ports'));
		o.value('common', _('Common ports only (bypass P2P traffic)'));
		o.validate = function(section_id, value) {
			if (section_id && value && value !== 'common') {

				let ports = [];
				for (let i of value.split(',')) {
					if (!stubValidator.apply('port', i) && !stubValidator.apply('portrange', i))
						return _('Expecting: %s').format(_('valid port value'));
					if (ports.includes(i))
						return _('Port %s already exists!').format(i);
					ports = ports.concat(i);
				}
			}

			return true;
		}

		o = s.taboption('routing', form.ListValue, 'proxy_mode', _('Proxy mode'));
		o.value('redirect', _('Redirect TCP'));
		if (features.hp_has_tproxy)
			o.value('redirect_tproxy', _('Redirect TCP + TProxy UDP'));
		if (features.hp_has_ip_full && features.hp_has_tun) {
			o.value('redirect_tun', _('Redirect TCP + Tun UDP'));
			o.value('tun', _('Tun TCP/UDP'));
		} else {
			o.description = _('To enable Tun support, you need to install <code>ip-full</code> and <code>kmod-tun</code>');
		}
		o.default = 'redirect_tproxy';
		o.rmempty = false;

		o = s.taboption('routing', form.ListValue, 'tcpip_stack', _('TCP/IP stack'),
			_('TCP/IP stack used by the TUN inbound.'));
		o.value('system', _('System'));
		o.value('gvisor', _('gVisor'));
		o.value('mixed', _('Mixed (recommended)'));
		o.default = 'system';
		o.rmempty = false;
		o.depends('proxy_mode', /tun/);

		o = s.taboption('routing', form.Flag, 'ipv6_support', _('IPv6 support'));
		o.default = o.enabled;
		o.rmempty = false;

		/* Application routing start */
		s.tab('app_rules', _('Routing Rules'));
		o = s.taboption('app_rules', form.SectionValue, '_app_rules', form.GridSection, 'app_rule');

		ss = o.subsection;
		ss.addremove = true;
		ss.rowcolors = true;
		ss.sortable = true;
		ss.nodescriptions = true;
		ss.modaltitle = L.bind(hp.loadModalTitle, this, _('Routing rule'), _('Add a routing rule'), data[0]);
		ss.sectiontitle = L.bind(hp.loadDefaultLabel, this, data[0]);
		ss.renderSectionAdd = L.bind(hp.renderSectionAdd, this, ss);

		so = ss.option(form.Flag, 'enabled', _('Enable'));
		so.default = so.enabled;
		so.rmempty = false;
		so.editable = true;

		so = ss.option(form.ListValue, 'source', _('Service'));
		so.value('youtube', _('YouTube'));
		so.value('tiktok', _('TikTok'));
		so.value('telegram', _('Telegram'));
		so.value('twitter', _('Twitter/X'));
		so.value('google', _('Google'));
		so.value('cloudflare', _('Cloudflare'));
		so.value('github', _('GitHub'));
		so.value('ai_noncn', _('AI Services (Non-Mainland China)'));
		so.value('custom', _('Custom'));
		so.rmempty = false;
		so.editable = true;

		so = ss.option(form.Value, 'custom_service_name', _('Service name'));
		so.placeholder = _('e.g. My Service');
		so.depends('source', 'custom');
		so.modalonly = true;
		so.retain = true;

		so = ss.option(form.ListValue, 'custom_mode', _('Custom rule type'));
		so.value('url_domain', _('Domain rule-set'));
		so.value('url_ip', _('IP rule-set'));
		so.value('url_mixed', _('Mixed rule-set (domain + IP)'));
		so.value('domains', _('Domain list'));
		so.default = 'url_domain';
		so.rmempty = false;
		so.depends('source', 'custom');
		so.modalonly = true;
		so.retain = true;

		so = ss.option(form.DynamicList, 'custom_url', _('Domain rule-set URL'));
		so.placeholder = 'https://example.com/rule-set.srs';
		so.depends({'source': 'custom', 'custom_mode': 'url_domain'});
		so.depends({'source': 'custom', 'custom_mode': 'url_mixed'});
		so.modalonly = true;
		so.retain = true;
		so.validate = function(section_id, value) {
			if (section_id && value && !/^https?:\/\/.+/.test(value))
				return _('Expecting: %s').format(_('a valid URL starting with http:// or https://'));

			return true;
		};

		so = ss.option(form.DynamicList, 'custom_url_ip', _('IP rule-set URL'));
		so.placeholder = 'https://example.com/rule-set.srs';
		so.depends({'source': 'custom', 'custom_mode': 'url_ip'});
		so.depends({'source': 'custom', 'custom_mode': 'url_mixed'});
		so.modalonly = true;
		so.retain = true;
		so.validate = function(section_id, value) {
			if (section_id && value && !/^https?:\/\/.+/.test(value))
				return _('Expecting: %s').format(_('a valid URL starting with http:// or https://'));

			return true;
		};

		so = ss.option(form.ListValue, 'custom_format', _('Rule-set format'));
		so.value('binary', _('Binary (.srs)'));
		so.value('source', _('JSON (.json)'));
		so.default = 'binary';
		so.rmempty = false;
		so.depends({'source': 'custom', 'custom_mode': 'url_domain'});
		so.depends({'source': 'custom', 'custom_mode': 'url_ip'});
		so.depends({'source': 'custom', 'custom_mode': 'url_mixed'});
		so.modalonly = true;
		so.retain = true;

		so = ss.option(form.TextValue, 'custom_domains', _('Custom domains'),
			_('One domain (or domain keyword) per line.'));
		so.rows = 5;
		so.monospace = true;
		so.depends({'source': 'custom', 'custom_mode': 'domains'});
		so.modalonly = true;
		so.retain = true;
		so.validate = function(section_id, value) {
			if (section_id && value)
				for (let i of value.split('\n')) {
					i = i.trim();
					if (i && !stubValidator.apply('hostname', i))
						return _('Expecting: %s').format(_('valid hostname'));
				}

			return true;
		};

		so = ss.option(form.ListValue, 'node', _('Node'));
		so.value('main-out', _('Same as main node'));
		so.value('urltest', _('Separate URLTest'));
		so.value('direct-out', _('Direct'));
		so.value('reject-out', _('Reject'));
		for (let i in proxy_nodes)
			so.value(i, proxy_nodes[i]);
		so.default = 'main-out';
		so.rmempty = false;
		so.editable = true;

		so = ss.option(hp.CBIStaticList, 'urltest_nodes', _('URLTest nodes'),
			_('List of nodes to test.'));
		for (let i in proxy_nodes)
			so.value(i, proxy_nodes[i]);
		so.depends('node', 'urltest');
		so.rmempty = false;
		so.modalonly = true;
		so.retain = true;

		so = ss.option(form.Value, 'urltest_interval', _('Test interval'),
			_('The test interval in seconds.'));
		so.datatype = 'uinteger';
		so.placeholder = '120';
		so.depends('node', 'urltest');
		so.modalonly = true;
		so.retain = true;

		so = ss.option(form.Value, 'urltest_tolerance', _('Test tolerance'),
			_('The test tolerance in milliseconds.'));
		so.datatype = 'uinteger';
		so.placeholder = '40';
		so.depends('node', 'urltest');
		so.modalonly = true;
		so.retain = true;

		so = ss.option(form.Flag, 'urltest_interrupt_exist_connections', _('Interrupt existing connections'));
		so.default = so.disabled;
		so.rmempty = false;
		so.depends('node', 'urltest');
		so.modalonly = true;
		so.retain = true;
		/* Application routing end */

		/* Dashboard settings start */
		s.tab('dashboard', _('Dashboard'));

		o = s.taboption('dashboard', form.Value, 'dashboard_port', _('Listen port'));
		o.default = '9096';
		o.datatype = 'port';
		o.rmempty = false;

		o = s.taboption('dashboard', form.Value, 'dashboard_secret', _('API secret'));
		o.password = true;
		o.rmempty = true;

		o = s.taboption('dashboard', form.Button, '_open_dashboard', _('Dashboard'));
		o.inputtitle = _('Open dashboard');
		o.inputstyle = 'apply';
		o.onclick = function() {
			let host = window.location.hostname,
			    port = uci.get('homeproxy', 'config', 'dashboard_port') || '9096';
			if (host.includes(':') && !host.startsWith('['))
				host = '[' + host + ']';
			window.open('http://' + host + ':' + port + '/dashboard/', '_blank', 'noopener,noreferrer');
		};
		/* Dashboard settings end */

		/* ACL settings start */
		s.tab('control', _('Access Control'));

		o = s.taboption('control', form.SectionValue, '_control', form.NamedSection, 'control', 'homeproxy');
		ss = o.subsection;

		/* Interface control start */
		ss.tab('interface', _('Interface Control'));

		so = ss.taboption('interface', widgets.DeviceSelect, 'listen_interfaces', _('Listen interfaces'),
			_('Only process traffic from specific interfaces. Leave empty for all.'));
		so.multiple = true;
		so.noaliases = true;

		so = ss.taboption('interface', widgets.DeviceSelect, 'bind_interface', _('Bind interface'),
			_('Bind outbound traffic to specific interface. Leave empty to auto detect.'));
		so.multiple = false;
		so.noaliases = true;
		/* Interface control end */

		/* LAN IP policy start */
		ss.tab('lan_ip_policy', _('LAN IP Policy'));

		so = ss.taboption('lan_ip_policy', form.ListValue, 'lan_proxy_mode', _('Proxy filter mode'));
		so.value('disabled', _('Disable'));
		so.value('listed_only', _('Proxy listed only'));
		so.value('except_listed', _('Proxy all except listed'));
		so.default = 'disabled';
		so.rmempty = false;

		so = fwtool.addIPOption(ss, 'lan_ip_policy', 'lan_direct_ipv4_ips', _('Direct IPv4 IP-s'), null, 'ipv4', hosts, true);
		so.depends('lan_proxy_mode', 'except_listed');

		so = fwtool.addIPOption(ss, 'lan_ip_policy', 'lan_direct_ipv6_ips', _('Direct IPv6 IP-s'), null, 'ipv6', hosts, true);
		so.depends({'lan_proxy_mode': 'except_listed', 'homeproxy.config.ipv6_support': '1'});

		so = fwtool.addMACOption(ss, 'lan_ip_policy', 'lan_direct_mac_addrs', _('Direct MAC-s'), null, hosts);
		so.depends('lan_proxy_mode', 'except_listed');

		so = fwtool.addIPOption(ss, 'lan_ip_policy', 'lan_proxy_ipv4_ips', _('Proxy IPv4 IP-s'), null, 'ipv4', hosts, true);
		so.depends('lan_proxy_mode', 'listed_only');

		so = fwtool.addIPOption(ss, 'lan_ip_policy', 'lan_proxy_ipv6_ips', _('Proxy IPv6 IP-s'), null, 'ipv6', hosts, true);
		so.depends({'lan_proxy_mode': 'listed_only', 'homeproxy.config.ipv6_support': '1'});

		so = fwtool.addMACOption(ss, 'lan_ip_policy', 'lan_proxy_mac_addrs', _('Proxy MAC-s'), null, hosts);
		so.depends('lan_proxy_mode', 'listed_only');

		so = fwtool.addIPOption(ss, 'lan_ip_policy', 'lan_gaming_mode_ipv4_ips', _('Gaming mode IPv4 IP-s'), null, 'ipv4', hosts, true);

		so = fwtool.addIPOption(ss, 'lan_ip_policy', 'lan_gaming_mode_ipv6_ips', _('Gaming mode IPv6 IP-s'), null, 'ipv6', hosts, true);
		so.depends('homeproxy.config.ipv6_support', '1');

		so = fwtool.addMACOption(ss, 'lan_ip_policy', 'lan_gaming_mode_mac_addrs', _('Gaming mode MAC-s'), null, hosts);

		so = fwtool.addIPOption(ss, 'lan_ip_policy', 'lan_global_proxy_ipv4_ips', _('Global proxy IPv4 IP-s'), null, 'ipv4', hosts, true);

		so = fwtool.addIPOption(ss, 'lan_ip_policy', 'lan_global_proxy_ipv6_ips', _('Global proxy IPv6 IP-s'), null, 'ipv6', hosts, true);
		so.depends('homeproxy.config.ipv6_support', '1');

		so = fwtool.addMACOption(ss, 'lan_ip_policy', 'lan_global_proxy_mac_addrs', _('Global proxy MAC-s'), null, hosts);
		/* LAN IP policy end */

		/* WAN IP policy start */
		ss.tab('wan_ip_policy', _('WAN IP Policy'));

		so = ss.taboption('wan_ip_policy', form.DynamicList, 'wan_proxy_ipv4_ips', _('Proxy IPv4 IP-s'));
		so.datatype = 'or(ip4addr, cidr4)';

		so = ss.taboption('wan_ip_policy', form.DynamicList, 'wan_proxy_ipv6_ips', _('Proxy IPv6 IP-s'));
		so.datatype = 'or(ip6addr, cidr6)';
		so.depends('homeproxy.config.ipv6_support', '1');

		so = ss.taboption('wan_ip_policy', form.DynamicList, 'wan_direct_ipv4_ips', _('Direct IPv4 IP-s'));
		so.datatype = 'or(ip4addr, cidr4)';

		so = ss.taboption('wan_ip_policy', form.DynamicList, 'wan_direct_ipv6_ips', _('Direct IPv6 IP-s'));
		so.datatype = 'or(ip6addr, cidr6)';
		so.depends('homeproxy.config.ipv6_support', '1');
		/* WAN IP policy end */

		/* Proxy domain list start */
		ss.tab('proxy_domain_list', _('Proxy Domain List'));

		so = ss.taboption('proxy_domain_list', form.TextValue, '_proxy_domain_list');
		so.rows = 10;
		so.monospace = true;
		so.datatype = 'hostname';
		so.load = function(/* ... */) {
			return L.resolveDefault(callReadDomainList('proxy_list')).then((res) => {
				return res.content;
			}, {});
		}
		so.write = function(_section_id, value) {
			return callWriteDomainList('proxy_list', value);
		}
		so.remove = function(/* ... */) {
			return callWriteDomainList('proxy_list', '');
		}
		so.validate = function(section_id, value) {
			if (section_id && value)
				for (let i of value.split('\n'))
					if (i && !stubValidator.apply('hostname', i))
						return _('Expecting: %s').format(_('valid hostname'));

			return true;
		}
		/* Proxy domain list end */

		/* Direct domain list start */
		ss.tab('direct_domain_list', _('Direct Domain List'));

		so = ss.taboption('direct_domain_list', form.TextValue, '_direct_domain_list');
		so.rows = 10;
		so.monospace = true;
		so.datatype = 'hostname';
		so.load = function(/* ... */) {
			return L.resolveDefault(callReadDomainList('direct_list')).then((res) => {
				return res.content;
			}, {});
		}
		so.write = function(_section_id, value) {
			return callWriteDomainList('direct_list', value);
		}
		so.remove = function(/* ... */) {
			return callWriteDomainList('direct_list', '');
		}
		so.validate = function(section_id, value) {
			if (section_id && value)
				for (let i of value.split('\n'))
					if (i && !stubValidator.apply('hostname', i))
						return _('Expecting: %s').format(_('valid hostname'));

			return true;
		}
		/* Direct domain list end */
		/* ACL settings end */

		return m.render();
	}
});
