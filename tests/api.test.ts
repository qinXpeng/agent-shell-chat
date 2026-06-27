import { test } from "node:test";
import assert from "node:assert/strict";
import { sendMessage } from "../src/weixin/api.js";
import { MessageState, MessageType } from "../src/weixin/types.js";

const baseMessage = {
  msg: {
    from_user_id: "",
    to_user_id: "user123",
    client_id: "client123",
    message_type: MessageType.BOT,
    message_state: MessageState.FINISH,
    context_token: "ctx",
    item_list: [{ type: 1, text_item: { text: "hello" } }],
  },
};

test("sendMessage rejects non-zero WeChat business return codes", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ ret: 123, errcode: 456, errmsg: "too many messages" }), {
      status: 200,
    });

  try {
    await assert.rejects(
      () => sendMessage({ baseUrl: "https://fake.weixin.local", body: baseMessage }),
      /WeChat API ilink\/bot\/sendmessage failed: ret=123 errcode=456 errmsg=too many messages/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("sendMessage accepts zero WeChat business return codes", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ ret: 0 }), { status: 200 });

  try {
    await sendMessage({ baseUrl: "https://fake.weixin.local", body: baseMessage });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
