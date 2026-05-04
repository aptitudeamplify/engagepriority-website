const MAKE_AGENT_RESPONSE_WEBHOOK =
process.env.MAKE_AGENT_RESPONSE_WEBHOOK_URL;

const noCacheHeaders = {
"Content-Type": "text/html; charset=utf-8",
"Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0",
"Pragma": "no-cache",
"Expires": "0",
"Surrogate-Control": "no-store",
"X-Robots-Tag": "noindex, nofollow"
};

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#039;");
}

function page(title, body) {
return `<!doctype html>

<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
</head>
<body style="font-family: Arial; text-align:center; padding:40px;">
${body}
</body>
</html>`;
}

function errorPage(message) {
return page("Error", `<h2>${escapeHtml(message)}</h2>`);
}

exports.handler = async function (event) {
try {
const shortCode = event.queryStringParameters?.short_code;

if (!shortCode) {
  return {
    statusCode: 400,
    headers: noCacheHeaders,
    body: errorPage("Invalid link")
  };
}

const response = await fetch(MAKE_AGENT_RESPONSE_WEBHOOK, {
  method: "POST",
  headers: {
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    short_code: shortCode
  })
});

const data = await response.json();

if (data.status !== "SUCCESS") {
  return {
    statusCode: 200,
    headers: noCacheHeaders,
    body: errorPage("Link expired or invalid")
  };
}

if (data.action_type !== "CALL_NOW") {
  return {
    statusCode: 200,
    headers: noCacheHeaders,
    body: errorPage("Invalid action")
  };
}

const phone = data.display?.phone;
const name = data.display?.lead_name || "Lead";

return {
  statusCode: 200,
  headers: noCacheHeaders,
  body: page(
    "Call Lead",
    `<h1>Call ${escapeHtml(name)}</h1>
     <a href="tel:${escapeHtml(phone)}" style="font-size:20px;">Call Now</a>`
  )
};

} catch (err) {
return {
statusCode: 500,
headers: noCacheHeaders,
body: errorPage("System error")
};
}
};
