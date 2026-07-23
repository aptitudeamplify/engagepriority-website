# EP-TODO-020 Stage 2 Source-Only Semantic Engine Candidate

This directory contains a deterministic transport of the reviewed Stage 2 source package.

## Reconstruction

Concatenate `source-bundle-parts/part-01.b64part` through `part-07.b64part` in numeric order, base64-decode the result, then extract the deterministic tar.gz archive.

The reconstructed archive SHA-256 must equal:

`70c1e4f095c9b100511b7dda1b14186196599881a32a223f2db21762e80fd6de`

The exact source identities are recorded in `source-bundle-manifest.json`.

## Containment boundary

- source transport only;
- based on the accepted Stage 1 source-only branch;
- outside the published `uat-static` artifact;
- no Netlify Function, Edge Function, scheduled Function, route, or environment dependency;
- no Make, GAS, Sheets, Twilio, webhook, recipient, queue, gateway, owner-clock, or lifecycle connection;
- no provider request or write capability;
- no Stage 3 behavior;
- no build or deployment authorization;
- no merge into the Stage 1 branch or website `main` without separate authorization.

The package remains `STAGE2_NON_ACTIONABLE_PREVIEW` only.
