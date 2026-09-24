# Changelog

## [1.2.0](https://github.com/chrischall/simplisafe-mcp/compare/v1.1.3...v1.2.0) (2026-09-24)


### Features

* confirm writes with a preview token instead of confirm: true ([#82](https://github.com/chrischall/simplisafe-mcp/issues/82)) ([ac0bf22](https://github.com/chrischall/simplisafe-mcp/commit/ac0bf229e3b3fd62c94d4a721385598f40d56bc4))

## [1.1.3](https://github.com/chrischall/simplisafe-mcp/compare/v1.1.2...v1.1.3) (2026-09-23)


### Bug Fixes

* harden SimpliSafe control verification, token cache and PIN disclosure (audit mediums) ([#80](https://github.com/chrischall/simplisafe-mcp/issues/80)) ([aa85292](https://github.com/chrischall/simplisafe-mcp/commit/aa852925866a28aad5ff8b38961be01454faa80d))

## [1.1.2](https://github.com/chrischall/simplisafe-mcp/compare/v1.1.1...v1.1.2) (2026-09-23)


### Bug Fixes

* **deps:** bump dotenv from 17.4.2 to 18.0.1 ([#76](https://github.com/chrischall/simplisafe-mcp/issues/76)) ([0dc7c21](https://github.com/chrischall/simplisafe-mcp/commit/0dc7c21eec40ce7db8231fde9a0ead37a402dd45))
* **deps:** bump zod in the production-dependencies group ([#75](https://github.com/chrischall/simplisafe-mcp/issues/75)) ([b972310](https://github.com/chrischall/simplisafe-mcp/commit/b972310f5c7fdf62a3213e6f385fd0fe96bed2b6))
* **deps:** require zod ^4.6.5 to match @chrischall/mcp-utils 2.4.0 ([#79](https://github.com/chrischall/simplisafe-mcp/issues/79)) ([654c568](https://github.com/chrischall/simplisafe-mcp/commit/654c5687a6b569dec67a5a775086f662a45be19a))
* **deps:** upgrade @chrischall/mcp-utils to 2.4.0 and @fetchproxy/* to 3.2.0 ([#78](https://github.com/chrischall/simplisafe-mcp/issues/78)) ([e3307ac](https://github.com/chrischall/simplisafe-mcp/commit/e3307acbc97248cabdd45a72a443858480ddf852))

## [1.1.1](https://github.com/chrischall/simplisafe-mcp/compare/v1.1.0...v1.1.1) (2026-09-21)


### Bug Fixes

* **tools:** say that arming and unlocking are destructive ([#71](https://github.com/chrischall/simplisafe-mcp/issues/71)) ([5f975b0](https://github.com/chrischall/simplisafe-mcp/commit/5f975b03ace0c3ad9aad99c5640146b37fad7844))

## [1.1.0](https://github.com/chrischall/simplisafe-mcp/compare/v1.0.0...v1.1.0) (2026-09-19)


### Features

* **deps:** take mcp-utils 1.0.0, booting through serveStdio ([#69](https://github.com/chrischall/simplisafe-mcp/issues/69)) ([623e622](https://github.com/chrischall/simplisafe-mcp/commit/623e622dff011db9f3a32913bca35049c1161b61))

## [1.0.0](https://github.com/chrischall/simplisafe-mcp/compare/v0.2.2...v1.0.0) (2026-09-19)


### ⚠ BREAKING CHANGES

* **mcp:** migrate server to SDK v2 ([#66](https://github.com/chrischall/simplisafe-mcp/issues/66))

### Features

* **mcp:** migrate server to SDK v2 ([#66](https://github.com/chrischall/simplisafe-mcp/issues/66)) ([dba30fe](https://github.com/chrischall/simplisafe-mcp/commit/dba30fe87b9774dc1d105d21fa44488b1617c1b9))

## [0.2.2](https://github.com/chrischall/simplisafe-mcp/compare/v0.2.1...v0.2.2) (2026-09-15)


### Bug Fixes

* **deps:** bump the production-dependencies group with 2 updates ([#63](https://github.com/chrischall/simplisafe-mcp/issues/63)) ([721e5e5](https://github.com/chrischall/simplisafe-mcp/commit/721e5e5451348c85f53693c9a3b79dc9a760db4a))

## [0.2.1](https://github.com/chrischall/simplisafe-mcp/compare/v0.2.0...v0.2.1) (2026-09-10)


### Bug Fixes

* **deps:** @chrischall/mcp-utils 0.26.1 ([#60](https://github.com/chrischall/simplisafe-mcp/issues/60)) ([433edce](https://github.com/chrischall/simplisafe-mcp/commit/433edce08cec037060cf220ae977df63bccd2a14))
* **deps:** bump hono from 4.13.0 to 4.13.7 ([#58](https://github.com/chrischall/simplisafe-mcp/issues/58)) ([6798cf7](https://github.com/chrischall/simplisafe-mcp/commit/6798cf737a720074ba8f7f1d55702e4a58596dbb))

## [0.2.0](https://github.com/chrischall/simplisafe-mcp/compare/v0.1.3...v0.2.0) (2026-09-04)


### Features

* **tools:** minify every response — no formatting whitespace on any payload ([#44](https://github.com/chrischall/simplisafe-mcp/issues/44)) ([35338d0](https://github.com/chrischall/simplisafe-mcp/commit/35338d0583bf2a3dfe2ba0c8f989c24c3a870834))


### Bug Fixes

* **build:** restore the literal em dash in the package description ([#48](https://github.com/chrischall/simplisafe-mcp/issues/48)) ([58f7d85](https://github.com/chrischall/simplisafe-mcp/commit/58f7d85014ba389660ac3fa7ac608694d69a1a12))


### Refactor

* **tools:** drop the unused src/view.ts scaffolding ([#49](https://github.com/chrischall/simplisafe-mcp/issues/49)) ([c93f9b5](https://github.com/chrischall/simplisafe-mcp/commit/c93f9b5a570d4532647b5557de7897bead5bb907))


### Documentation

* **api:** stop claiming two undocumented surfaces are "documented above" ([#51](https://github.com/chrischall/simplisafe-mcp/issues/51)) ([408f64b](https://github.com/chrischall/simplisafe-mcp/commit/408f64b15da9470348a1cba5f0fcba23eb904ef7))

## [0.1.3](https://github.com/chrischall/simplisafe-mcp/compare/v0.1.2...v0.1.3) (2026-08-28)


### Bug Fixes

* persist the rotated refresh token instead of losing it on exit ([#26](https://github.com/chrischall/simplisafe-mcp/issues/26)) ([0bce08f](https://github.com/chrischall/simplisafe-mcp/commit/0bce08fa8492476b567eccb5125cc81bb588acc2))


### Documentation

* publish the cache env vars in server.json and .env.example ([#31](https://github.com/chrischall/simplisafe-mcp/issues/31)) ([a0cd64c](https://github.com/chrischall/simplisafe-mcp/commit/a0cd64c332107fdb6022c921795d99e83c5cec33))

## [0.1.2](https://github.com/chrischall/simplisafe-mcp/compare/v0.1.1...v0.1.2) (2026-08-07)


### Bug Fixes

* **connector:** finish the retirement sweep ([#14](https://github.com/chrischall/simplisafe-mcp/issues/14)) ([63376d9](https://github.com/chrischall/simplisafe-mcp/commit/63376d9cf43948669dd07406fdd4babd7760c15a))


### Refactor

* **connector:** retire the standalone Cloudflare Worker connector ([#11](https://github.com/chrischall/simplisafe-mcp/issues/11)) ([8f47654](https://github.com/chrischall/simplisafe-mcp/commit/8f4765437b61392f7e09c5708679d9c5261d6887))

## [0.1.1](https://github.com/chrischall/simplisafe-mcp/compare/v0.1.0...v0.1.1) (2026-07-28)


### Bug Fixes

* **connector:** keep the callback box revealed when a retry fails ([#6](https://github.com/chrischall/simplisafe-mcp/issues/6)) ([c69410c](https://github.com/chrischall/simplisafe-mcp/commit/c69410cd7b9df24de2fca2da896e4ca37f70bb44)), closes [#4](https://github.com/chrischall/simplisafe-mcp/issues/4)
* **connector:** make the first login submit reachable ([#3](https://github.com/chrischall/simplisafe-mcp/issues/3)) ([0c42018](https://github.com/chrischall/simplisafe-mcp/commit/0c420183f2215933abbc21989e747d25a4c09a65))

## 0.1.0 (2026-07-28)


### Features

* SimpliSafe MCP server, curl access skill, and hosted connector ([3872429](https://github.com/chrischall/simplisafe-mcp/commit/3872429cb13662ea84cf87dbd8104d7e5cf7b7a5))


### Bug Fixes

* **connector:** point OAUTH_KV at the real KV namespace ([#2](https://github.com/chrischall/simplisafe-mcp/issues/2)) ([a01e637](https://github.com/chrischall/simplisafe-mcp/commit/a01e637363d9c26f7147fc17ceb0c12371ceb99d))
