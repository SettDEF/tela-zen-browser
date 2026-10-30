# Maintainer: caesar
pkgname=tela-zen
pkgver=1.21.16b
pkgrel=52
pkgdesc="Tela's Zen Browser build (Firefox 154.0.1 base)"
arch=('x86_64')
url="https://github.com/zen-browser/desktop"
license=('MPL-2.0')
depends=(
  'gtk3' 'libxt' 'dbus-glib' 'ffmpeg' 'libpulse' 'ttf-font'
  'libxss' 'libxrandr' 'mesa' 'nss' 'alsa-lib'
)
provides=('zen-browser')
conflicts=('zen-browser' 'zen-browser-bin')
options=('!strip' '!emptydirs')
install=tela-zen.install

# Built locally by scripts/tela-update.sh - not fetched, so no source= array.
# The tarball's own version segment tracks Zen's upstream version, not
# pkgver, so it can drift out of sync with this file - resolve by glob
# rather than hardcoding the name.
_pkg_tarball="$(compgen -G '/mnt/storage/dev/projects/tela-zen/engine/obj-x86_64-pc-linux-gnu/dist/zen-*.en-US.linux-x86_64.tar.xz' | head -1)"

package() {
  if [ ! -f "$_pkg_tarball" ]; then
    echo "Missing build artifact: $_pkg_tarball" >&2
    echo "Run scripts/tela-update.sh (sync, build, package) first." >&2
    return 1
  fi

  install -d "$pkgdir/opt/tela-zen"
  tar xf "$_pkg_tarball" -C "$pkgdir/opt/tela-zen" --strip-components=1

  install -d "$pkgdir/usr/bin"
  ln -s /opt/tela-zen/zen "$pkgdir/usr/bin/tela-zen"

  for size in 16 32 48 64 128; do
    local icon="$pkgdir/opt/tela-zen/browser/chrome/icons/default/default${size}.png"
    if [ -f "$icon" ]; then
      install -Dm644 "$icon" \
        "$pkgdir/usr/share/icons/hicolor/${size}x${size}/apps/tela-zen.png"
    fi
  done

  install -Dm644 /dev/stdin "$pkgdir/usr/share/applications/tela-zen.desktop" <<-EOF
	[Desktop Entry]
	Name=Tela Zen
	Comment=Tela's Zen Browser build
	Exec=/opt/tela-zen/zen %u
	Terminal=false
	Type=Application
	Icon=tela-zen
	Categories=Network;WebBrowser;
	MimeType=text/html;text/xml;application/xhtml+xml;x-scheme-handler/http;x-scheme-handler/https;
	StartupNotify=true
	StartupWMClass=zen
	EOF
}
