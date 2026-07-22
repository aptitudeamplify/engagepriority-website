# EP-TODO-020 Stage 1 Source-Only Header Adapter

This directory contains the Stage 1 Netlify header-resolution adapter and bounded fixtures.

Boundary:

- source preparation only;
- not included in the published `uat-static` artifact;
- no Netlify Function, Edge Function, or scheduled Function;
- no environment variable, credential, webhook, Sheet, Make, GAS, Twilio, email, SMS, gateway, queue, or lifecycle connection;
- no Stage 2 policy behavior;
- no deployment or merge into website `main`.

Validation command:

```text
node stage1-src/header-adapter.test.js
```

The adapter resolves fields by exact header name and fails closed on blank, duplicate, missing required, or unknown closed-schema headers.
