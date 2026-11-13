# Security Policy

## Supported versions

Security fixes are released for the latest minor version of `adk-llm-bridge`.

| Version | Supported |
|---------|-----------|
| 0.7.x   | Yes       |
| < 0.7   | No        |

## Reporting a vulnerability

Please do not open a public issue for a security problem.

Report it privately with GitHub's private vulnerability reporting: open the
[Security tab](https://github.com/pailat/adk-llm-bridge/security) of the
repository and choose **Report a vulnerability**. Include the affected version,
the runtime (Node.js or Bun), a description of the impact, and the steps or a
minimal example that reproduce it. Do not include real API keys or credentials.

If you cannot use GitHub private vulnerability reporting, email
alex.sanchez@pai.lat instead. Do not put vulnerability details in a public issue
or pull request.

## What to expect

1. We acknowledge the report.
2. We confirm the problem and its impact, and keep you informed.
3. We prepare a fix and release it in a supported version.
4. We publish a GitHub security advisory that describes the issue and credits
   the reporter, unless the reporter asks to stay anonymous.

Please keep the details private until the advisory is published.

## Scope

In scope: vulnerabilities in the `adk-llm-bridge` package, for example leaking
credentials, bypassing the permission and sandbox rules of external agents, or
unsafe handling of model output. Vulnerabilities in the LLM providers, in
`@google/adk` or in other dependencies belong to those projects; report them
there.
