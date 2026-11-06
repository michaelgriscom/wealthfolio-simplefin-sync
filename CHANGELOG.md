# Changelog

## [1.0.3](https://github.com/michaelgriscom/wealthfolio-simplefin-sync/compare/v1.0.2...v1.0.3) (2026-11-06)


### Bug Fixes

* date snapshots with the local date instead of UTC ([4ada28f](https://github.com/michaelgriscom/wealthfolio-simplefin-sync/commit/4ada28fb7b7e8babc54fd39abc86a9bc6e6e46a4))
* keep syncing mapped accounts that have no holdings ([7b00c1a](https://github.com/michaelgriscom/wealthfolio-simplefin-sync/commit/7b00c1a4a3981f3381f8d74b0f6de03a236214d6))
* let Retry save store the held credential without reclaiming the token ([705f83a](https://github.com/michaelgriscom/wealthfolio-simplefin-sync/commit/705f83ac0a00cfacec734e473405ba978fb9ad3f))
* let Wealthfolio date snapshots instead of passing a date ([fc3460a](https://github.com/michaelgriscom/wealthfolio-simplefin-sync/commit/fc3460a0322881390f5d581b5de9acdeee365404))
* lock the token input while a claimed credential is held ([b7c39a2](https://github.com/michaelgriscom/wealthfolio-simplefin-sync/commit/b7c39a2fb44d8e4dd636f5b434bb3f14ba7a8da8))
* never write a zero-position snapshot from untrusted holdings ([ef96435](https://github.com/michaelgriscom/wealthfolio-simplefin-sync/commit/ef964354bde2aa59a92407a427c6d271a68ad8f0))
* reject an access URL that carries no credentials ([f022d3a](https://github.com/michaelgriscom/wealthfolio-simplefin-sync/commit/f022d3a5ba9f97dc01a175c5a87c7e28fb362251))

## [1.0.2](https://github.com/michaelgriscom/wealthfolio-simplefin-sync/compare/v1.0.1...v1.0.2) (2026-07-27)


### Bug Fixes

* report correct addon version number in Wealthfolio UI ([#14](https://github.com/michaelgriscom/wealthfolio-simplefin-sync/issues/14)) ([0eb593b](https://github.com/michaelgriscom/wealthfolio-simplefin-sync/commit/0eb593b654cb4428e7338d5c5242a9b17b1a481e))

## [1.0.1](https://github.com/michaelgriscom/wealthfolio-simplefin-sync/compare/v1.0.0...v1.0.1) (2026-07-24)


### Bug Fixes

* migrate to the Wealthfolio 3.6 addon sandbox ([#12](https://github.com/michaelgriscom/wealthfolio-simplefin-sync/issues/12)) ([6c02b3a](https://github.com/michaelgriscom/wealthfolio-simplefin-sync/commit/6c02b3a516ead7e765b45ca777a8cb3a1a84894e))

## 1.0.0 (2026-06-27)


### Features

* accept a SimpleFIN setup token or access URL in the addon ([4bcf66a](https://github.com/michaelgriscom/wealthfolio-simplefin-sync/commit/4bcf66a0cd3b51304d3aaf135bfaff9c34f5efec))
* add automated daily sync daemon ([eb1e3a0](https://github.com/michaelgriscom/wealthfolio-simplefin-sync/commit/eb1e3a04ffdb157d985d9eadf48726e9ecd40b88))
* initial SimpleFIN Sync addon ([c2700b3](https://github.com/michaelgriscom/wealthfolio-simplefin-sync/commit/c2700b39b85b7df69e33a686b73aadf3248ccc3e))


### Bug Fixes

* reload sync config each run so mapping edits apply without a restart ([19c0d02](https://github.com/michaelgriscom/wealthfolio-simplefin-sync/commit/19c0d02129115e2a71ba016705633c61bf20ba7d))
* replace SimpleFIN access URL with token ([8e09f46](https://github.com/michaelgriscom/wealthfolio-simplefin-sync/commit/8e09f46644b9feab71cb380399f9b0c5f2773bd5))
* set exchange on synced holdings so prices can correctly auto update ([38fa696](https://github.com/michaelgriscom/wealthfolio-simplefin-sync/commit/38fa696484a5f010658f3a3ed159f2736e755b49))
