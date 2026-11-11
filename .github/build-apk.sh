#!/bin/bash
# SPDX-License-Identifier: GPL-2.0-only
#
# Build a single .apk package for OpenWrt snapshots (apk-tools 3.x).
#
# Usage: fakeroot bash build-apk.sh [snapshot|release] [version override]
#
# Runtime dependencies are read from LUCI_DEPENDS in the package Makefile, so
# there is only one place to keep them in sync.

set -o errexit
set -o pipefail

RELEASE_TYPE="${1:-snapshot}"
VERSION_OVERRIDE="${2:-}"

export PKG_SOURCE_DATE_EPOCH="$(date "+%s")"
export SOURCE_DATE_EPOCH="$PKG_SOURCE_DATE_EPOCH"

BASE_DIR="$(cd "$(dirname $0)"; pwd)"
PKG_DIR="$(cd "$BASE_DIR/.."; pwd)"

function get_mk_value() {
	awk -F "$1:=" '{print $2}' "$PKG_DIR/Makefile" | xargs
}

# LUCI_DEPENDS is a multi-line value, so it cannot use get_mk_value
function get_mk_depends() {
	sed -n '/^LUCI_DEPENDS:=/,/[^\\]$/p' "$PKG_DIR/Makefile" |
		sed -e 's/^LUCI_DEPENDS:=//' -e 's/\\$//' |
		tr -s ' \t\n' ' ' |
		tr -d '+' |
		xargs
}

PKG_NAME="$(get_mk_value "PKG_NAME")"
if [ -z "$PKG_NAME" ]; then
	echo -e "Failed to read PKG_NAME from $PKG_DIR/Makefile." >&2
	exit 1
fi

PKG_DESC="$(get_mk_value "LUCI_TITLE")"
PKG_ARCH="$(get_mk_value "LUCI_PKGARCH")"
PKG_ARCH="${PKG_ARCH:-all}"

PKG_REPO="$(git -C "$PKG_DIR" remote get-url origin 2>"/dev/null" |
	sed -e 's/\.git$//' -e 's,^git@github\.com:,https://github.com/,' || echo "")"
PKG_MAINTAINER="$(git -C "$PKG_DIR" log -1 --format='%an <%ae>' 2>"/dev/null" || echo "Unknown")"

# apk versions must not carry a leading "v" nor any odd character
if [ -n "$VERSION_OVERRIDE" ]; then
	PKG_VERSION="${VERSION_OVERRIDE#v}"
elif [ "$RELEASE_TYPE" == "release" ]; then
	PKG_VERSION="$(git -C "$PKG_DIR" describe --tags --always 2>"/dev/null" || echo "0.0.0")"
	PKG_VERSION="${PKG_VERSION#v}"
else
	PKG_VERSION="$(date -u "+%Y.%m.%d")-r$(git -C "$PKG_DIR" rev-list --count HEAD 2>"/dev/null" || echo 0)"
fi
PKG_VERSION="$(echo -e "$PKG_VERSION" | tr -c 'A-Za-z0-9.+~_-' '.' | sed -e 's/^\.*//' -e 's/\.*$//')"
if [ -z "$PKG_VERSION" ]; then
	PKG_VERSION="0.0.0"
fi

# luci.mk injects luci-base at build time, so it has to be listed manually here
PKG_DEPENDS="libc luci-base $(get_mk_depends)"

TEMP_DIR="$(mktemp -d -p "$BASE_DIR")"
TEMP_PKG_DIR="$TEMP_DIR/$PKG_NAME"
trap 'rm -rf "$TEMP_DIR"' EXIT

mkdir -p "$TEMP_PKG_DIR/lib/apk/packages/"
mkdir -p "$TEMP_PKG_DIR/lib/upgrade/keep.d/"
mkdir -p "$TEMP_PKG_DIR/usr/lib/lua/luci/i18n/"
mkdir -p "$TEMP_PKG_DIR/www/"

cp -fpR "$PKG_DIR/htdocs"/* "$TEMP_PKG_DIR/www/"
cp -fpR "$PKG_DIR/root"/* "$TEMP_PKG_DIR/"

cat > "$TEMP_PKG_DIR/lib/upgrade/keep.d/$PKG_NAME" <<-EOF
/etc/homeproxy/certs/
/etc/homeproxy/dashboard/
/etc/homeproxy/ruleset/
/etc/homeproxy/resources/direct_list.txt
/etc/homeproxy/resources/proxy_list.txt
EOF

if [ -f "$PKG_DIR/po/zh_Hans/homeproxy.po" ]; then
	po2lmo "$PKG_DIR/po/zh_Hans/homeproxy.po" "$TEMP_PKG_DIR/usr/lib/lua/luci/i18n/homeproxy.zh-cn.lmo"
fi

# Package file list, used by the OpenWrt apk wrapper
find "$TEMP_PKG_DIR" -type f,l -printf '/%P\n' | sort > "$TEMP_PKG_DIR/lib/apk/packages/$PKG_NAME.list"

# Conffiles are shipped as a plain list plus pre-computed checksums
echo "/etc/config/homeproxy" > "$TEMP_PKG_DIR/lib/apk/packages/$PKG_NAME.conffiles"
while IFS= read -r file; do
	[ -f "$TEMP_PKG_DIR/$file" ] || continue
	sha256sum "$TEMP_PKG_DIR/$file" | sed "s,$TEMP_PKG_DIR/,," >> "$TEMP_PKG_DIR/lib/apk/packages/$PKG_NAME.conffiles_static"
done < "$TEMP_PKG_DIR/lib/apk/packages/$PKG_NAME.conffiles"

echo -e '#!/bin/sh
[ "${IPKG_NO_SCRIPT}" = "1" ] && exit 0
[ -s ${IPKG_INSTROOT}/lib/functions.sh ] || exit 0
. ${IPKG_INSTROOT}/lib/functions.sh
export root="${IPKG_INSTROOT}"
export pkgname="'"$PKG_NAME"'"
add_group_and_user
default_postinst
[ -n "${IPKG_INSTROOT}" ] || { rm -f /tmp/luci-indexcache.*
	rm -rf /tmp/luci-modulecache/
	killall -HUP rpcd 2>/dev/null
	exit 0
}' > "$TEMP_DIR/post-install"
chmod 0755 "$TEMP_DIR/post-install"

echo -e '#!/bin/sh
export PKG_UPGRADE=1
[ "${IPKG_NO_SCRIPT}" = "1" ] && exit 0
[ -s ${IPKG_INSTROOT}/lib/functions.sh ] || exit 0
. ${IPKG_INSTROOT}/lib/functions.sh
export root="${IPKG_INSTROOT}"
export pkgname="'"$PKG_NAME"'"
add_group_and_user
default_postinst
[ -n "${IPKG_INSTROOT}" ] || { rm -f /tmp/luci-indexcache.*
	rm -rf /tmp/luci-modulecache/
	killall -HUP rpcd 2>/dev/null
	exit 0
}' > "$TEMP_DIR/post-upgrade"
chmod 0755 "$TEMP_DIR/post-upgrade"

echo -e '#!/bin/sh
[ -s ${IPKG_INSTROOT}/lib/functions.sh ] || exit 0
. ${IPKG_INSTROOT}/lib/functions.sh
export root="${IPKG_INSTROOT}"
export pkgname="'"$PKG_NAME"'"
default_prerm' > "$TEMP_DIR/pre-deinstall"
chmod 0755 "$TEMP_DIR/pre-deinstall"

APK_SIGN_ARGS=""
if [ -n "${APK_SIGN_KEY:-}" ]; then
	APK_SIGN_ARGS="--sign-key $APK_SIGN_KEY"
	echo -e "Signing package with $APK_SIGN_KEY."
else
	echo -e "No APK_SIGN_KEY set, building an unsigned package (install it with --allow-untrusted)."
fi

apk mkpkg \
	--info "name:$PKG_NAME" \
	--info "version:$PKG_VERSION" \
	--info "description:$PKG_DESC" \
	--info "arch:noarch" \
	--info "origin:${PKG_REPO:-$PKG_NAME}" \
	--info "url:$PKG_REPO" \
	--info "maintainer:$PKG_MAINTAINER" \
	--info "depends:$PKG_DEPENDS" \
	--script "post-install:$TEMP_DIR/post-install" \
	--script "post-upgrade:$TEMP_DIR/post-upgrade" \
	--script "pre-deinstall:$TEMP_DIR/pre-deinstall" \
	$APK_SIGN_ARGS \
	--files "$TEMP_PKG_DIR" \
	--output "$TEMP_DIR/${PKG_NAME}_${PKG_VERSION}.apk"

APK_FILE="$BASE_DIR/${PKG_NAME}_${PKG_VERSION}_${PKG_ARCH}.apk"
mv -f "$TEMP_DIR/${PKG_NAME}_${PKG_VERSION}.apk" "$APK_FILE"

echo -e "Built: $(basename "$APK_FILE")"
echo -e "Version: $PKG_VERSION"
echo -e "Depends: $PKG_DEPENDS"
