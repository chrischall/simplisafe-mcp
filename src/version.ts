/**
 * Single source of truth for the server version.
 *
 * release-please rewrites the literal below on each release and keeps
 * package.json / manifest.json / server.json / .claude-plugin/* in step via the
 * `extra-files` list in release-please-config.json. Never hand-edit it.
 */
export const VERSION = '0.2.0'; // x-release-please-version
