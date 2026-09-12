"""The only file that talks to AWS.

Extraction goes through the Converse API's tool interface rather than through an
instruction to reply in JSON. The difference matters here: "return JSON" makes the
schema a request, so the failure mode is a well-formed reply with a renamed key or a
value where null was meant, and that arrives as a parse error at best and a silently
missing field at worst. A forced tool call makes the schema part of the request, and
the nine fields either come back in that shape or the call fails loudly.

`maxTokens` is generous on purpose. Claude Sonnet 5 emits a reasoning block before its
text and that block is charged against the cap, so a cap tight enough to look careful
returns a truncated response with the tool call cut off -- HTTP 200, no error, no
result. `truncated` is counted for exactly that reason.
"""

from __future__ import annotations

import os
import time
from dataclasses import dataclass, field
from typing import Any

import boto3
from botocore.config import Config

REGION = os.environ.get("AWS_REGION", "us-west-2")

# The `us.` prefix is a cross-region inference profile rather than a plain model id;
# without it this id is not invokable in most regions.
MODEL = os.environ.get("CLAUSE_CHECK_MODEL", "us.anthropic.claude-sonnet-5")

# Retries stay with botocore, which implements them properly. A second backoff layered
# on top turns one throttle into a minute of waiting.
_CONFIG = Config(retries={"max_attempts": 5, "mode": "adaptive"})


@dataclass
class Usage:
    """What the run cost. Reported, never estimated."""

    calls: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    seconds: float = 0.0
    truncated: int = 0
    errors: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return {
            "model": MODEL,
            "region": REGION,
            "calls": self.calls,
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "seconds": round(self.seconds, 1),
            "truncated": self.truncated,
            "errors": self.errors,
        }


class ToolCallMissing(RuntimeError):
    """The reply contained no tool call.

    Its own exception because the two causes need different fixes: a truncated response
    (raise the cap) and a model that answered in prose despite `toolChoice` (the schema
    or the prompt is wrong). Both look like "no result" from the caller.
    """


@dataclass
class Bedrock:
    """A thin Converse client. Everything above this layer is pure and testable."""

    region: str = REGION
    usage: Usage = field(default_factory=Usage)

    def __post_init__(self) -> None:
        self._client = boto3.client("bedrock-runtime", region_name=self.region, config=_CONFIG)

    def extract(
        self,
        system: str,
        prompt: str,
        tool: dict[str, Any],
        *,
        max_tokens: int = 4096,
    ) -> dict[str, Any]:
        """One forced tool call, returning the tool input as a dict.

        `temperature` is not passed. Sonnet 5 rejects it outright
        (`ValidationException: temperature is deprecated for this model`), so the usual
        lever for reproducibility does not exist and stability has to be measured by
        repeating the run instead of assumed.
        """
        started = time.monotonic()
        response = self._client.converse(
            modelId=MODEL,
            system=[{"text": system}],
            messages=[{"role": "user", "content": [{"text": prompt}]}],
            inferenceConfig={"maxTokens": max_tokens},
            toolConfig={
                "tools": [{"toolSpec": tool}],
                "toolChoice": {"tool": {"name": tool["name"]}},
            },
        )
        self.usage.seconds += time.monotonic() - started
        self.usage.calls += 1
        self.usage.input_tokens += response["usage"]["inputTokens"]
        self.usage.output_tokens += response["usage"]["outputTokens"]
        if response.get("stopReason") == "max_tokens":
            self.usage.truncated += 1

        for block in response["output"]["message"]["content"]:
            if "toolUse" in block:
                return dict(block["toolUse"]["input"])
        raise ToolCallMissing(f"stopReason={response.get('stopReason')}")
