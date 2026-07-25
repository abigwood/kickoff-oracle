const CORS_HEADERS = {
  "access-control-allow-origin": "https://abigwood.github.io",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
};

function json(body, status = 410) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      ...CORS_HEADERS,
    },
  });
}

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    return json({
      ok: false,
      retired: true,
      service: "kickoff-oracle-window",
      message: "KickOff Oracle has been decommissioned.",
    });
  },

  async scheduled() {
    return;
  },
};
