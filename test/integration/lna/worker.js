async function firstEvent(res) {
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffered = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return null;
    buffered += value;
    const lines = buffered.split('\n');
    buffered = lines.pop();
    const event = lines.map((line) => JSON.parse(line)).find((line) => !line.ping);
    if (event) {
      await reader.cancel();
      return event;
    }
  }
}

async function call({ url, method = 'POST', headers = {}, body, watch }) {
  try {
    const res = await fetch(url, { method, headers, body });
    if (watch) return { status: res.status, event: await firstEvent(res) };
    return { status: res.status, errno: res.headers.get('X-Hostfs-Errno'), text: await res.text() };
  } catch (error) {
    return { error: error.message };
  }
}

addEventListener('message', async (event) => {
  event.ports[0].postMessage(await call(event.data));
});
