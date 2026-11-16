# OCEAN Bot — image untuk Pterodactyl
#
# Image resmi Pterodactyl (`ghcr.io/pterodactyl/yolks:nodejs_20`) sudah punya
# `/entrypoint.sh`, user `container`, dan Node.js 20, tetapi TIDAK punya library
# native yang dibutuhkan `canvas` (dipakai command memegen). Tanpa library ini
# `npm ci` gagal saat kompilasi `canvas`, atau bot crash saat `require('canvas')`.
#
# Build (di host yang punya Docker — biasanya node Wings):
#   docker build -t ghcr.io/USER_GITHUB_KAMU/ocean-bot:node20 pterodactyl/
#   docker push ghcr.io/USER_GITHUB_KAMU/ocean-bot:node20
#
# Lalu pakai nama image itu di egg (lihat PTERODACTYL.md).
FROM ghcr.io/pterodactyl/yolks:nodejs_20

USER root

# Runtime + build deps untuk canvas 2.x, plus font agar teks meme ter-render.
RUN apk add --no-cache \
        cairo pango jpeg giflib librsvg pixman fontconfig ttf-dejavu \
        build-base python3 pkgconf \
        cairo-dev pango-dev jpeg-dev giflib-dev librsvg-dev pixman-dev

USER container

# Tidak ada COPY: source code di-upload ke volume /home/container lewat panel,
# bukan dibakar ke dalam image.
