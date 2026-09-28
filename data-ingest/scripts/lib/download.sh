#!/usr/bin/env bash
# Shared atomic-download helper: fetches url into dest, but only after
# checking whether dest is already up to date (via a sidecar .etag file
# storing the server's ETag/Last-Modified), and only ever writes dest via
# a same-directory temp file + mv, so a killed/interrupted download never
# leaves a corrupt dest in place -- mv within one directory is a rename,
# not a copy, so this is atomic even for the largest OSM extracts.
#
# Usage: download_file <url> <dest>
# Exit status: 0 if dest was (re)written, 2 if the server said 304 Not
# Modified and dest was left untouched, 1 on a real fetch failure. Callers
# that need to gate follow-up work (e.g. unzip) on "did this actually
# change" should check for exit status 2, not just dest's mtime -- dest's
# own mtime doesn't change on a 304, but a sidecar-touching caller could
# still be fooled by other mtime updates, so the exit code is the only
# reliable signal.
download_file() {
  local url="$1" dest="$2"
  local tmp="${dest}.part"
  local etag_file="${dest}.etag"

  mkdir -p "$(dirname "$dest")"

  local curl_args=(--fail --location --show-error --output "$tmp")
  if [ -f "$dest" ] && [ -f "$etag_file" ]; then
    curl_args+=(--header "If-None-Match: $(cat "$etag_file")")
  fi

  echo "downloading $url -> $dest"
  local http_code
  http_code="$(curl "${curl_args[@]}" --write-out '%{http_code}' --dump-header "${tmp}.headers" "$url")"

  if [ "$http_code" = "304" ]; then
    echo "  not modified, keeping existing $dest"
    rm -f "$tmp" "${tmp}.headers"
    return 2
  fi
  if [ "$http_code" != "200" ]; then
    echo "  HTTP $http_code fetching $url" >&2
    rm -f "$tmp" "${tmp}.headers"
    return 1
  fi

  local etag
  etag="$(grep -i '^etag:' "${tmp}.headers" | sed -E 's/^[Ee][Tt][Aa][Gg]: *//' | tr -d '\r\n')"
  rm -f "${tmp}.headers"

  mv "$tmp" "$dest"
  if [ -n "$etag" ]; then
    echo "$etag" > "$etag_file"
  else
    rm -f "$etag_file"
  fi
  echo "  wrote $dest"
}
