// Build-time configuration. Left empty in the repository: CI (.github/workflows/pages.yml, release.yml, build.yml)
// writes the GitHub secret DHM_API_KEY into this file before publishing, so users can fetch DHM terrain without
// pasting a key. A key typed into the picker always takes precedence. Run tools/inject_dhm_key.py to set it locally.
export const DHM_API_KEY = '';
