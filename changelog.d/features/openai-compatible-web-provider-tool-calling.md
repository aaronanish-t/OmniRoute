---
title: OpenAI-compatible web-provider contracts and tool calling
type: feature
---

Established canonical OpenAI-compatible request, response, error, model-capability,
and web-provider tool-calling contracts, while documenting the existing auxiliary
endpoints and unsupported realtime capability. Web-cookie providers now
preserve stable tool-call IDs and indexes, parallel calls, tool results, streaming
serialization, and terminal `finish_reason: "tool_calls"` while failing closed for
unknown or malformed invocations.

Closes #14033
Closes #14034
Closes #14035
Closes #14036
Closes #14037
