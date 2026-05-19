# CommandCabin Versioning Policy

CommandCabin product releases use strict `x.y.z` versions.

- x: Major architecture changes or breaking product-direction changes.
- y: User-visible feature additions, such as new import flows, analysis capabilities, report capabilities, or interface features.
- z: Bug fixes, protocol rule fixes, copy or experience polish, and test hardening that do not add user-visible features.

All workspace package versions should stay aligned with the root package version so packaged builds, diagnostics, and release artifacts report the same product version.
