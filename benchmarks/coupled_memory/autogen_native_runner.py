import argparse
import asyncio
import importlib.metadata
import json
from pathlib import Path

from autogen_agentchat.agents import BaseChatAgent
from autogen_agentchat.base import Response
from autogen_agentchat.messages import TextMessage


class CoupledMemoryBenchAgent(BaseChatAgent):
    @property
    def produced_message_types(self):
        return (TextMessage,)

    async def on_messages(self, messages, cancellation_token):
        payload = json.loads(messages[-1].content)
        return Response(
            chat_message=TextMessage(
                content=json.dumps(payload, separators=(",", ":")),
                source=self.name,
            )
        )

    async def on_reset(self, cancellation_token):
        return None


async def run_agent(payload):
    agent = CoupledMemoryBenchAgent(
        "coupled_memory_autogen_native",
        description="Deterministic coupled-memory benchmark adapter.",
    )
    response = await agent.on_messages(
        [TextMessage(content=json.dumps(payload, separators=(",", ":")), source="benchmark")],
        cancellation_token=None,
    )
    return json.loads(response.chat_message.content)


def metadata():
    return {
        "autogen_agentchat": importlib.metadata.version("autogen-agentchat"),
        "autogen_core": importlib.metadata.version("autogen-core"),
        "sdk_features": ["BaseChatAgent", "TextMessage", "Response"],
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    payload = json.loads(Path(args.input).read_text(encoding="utf8"))
    result = asyncio.run(run_agent(payload))
    result["autogen_metadata"] = metadata()
    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    Path(args.output).write_text(json.dumps(result, indent=2) + "\n", encoding="utf8")


if __name__ == "__main__":
    main()
