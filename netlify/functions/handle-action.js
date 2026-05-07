const { google } = require("googleapis");

const MAKE_AGENT_RESPONSE_WEBHOOK =
  process.env.MAKE_AGENT_RESPONSE_WEBHOOK_URL;

const ACTION_LINK_MAP_SHEET_ID = "1xNhypMirxoz9IjMWxO0H8gxNSqqavs2W17pzx8HiZfw";

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

function rowsToObjects(rows) {
  const headers = rows[0] || [];

  return rows.slice(1).map(row => {
    const obj = {};
    headers.forEach((header, index) => {
      obj[header] = row[index];
    });
    return obj;
  });
}

function isExpired(expiresTsUtc) {
  const value = String(expiresTsUtc || "").trim();

  if (!value) {
    return false;
  }

  const expiresAt = new Date(value).getTime();

  if (!Number.isFinite(expiresAt)) {
    return true;
  }

  return expiresAt <= Date.now();
}

async function getSheetsClient() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"]
  });

  return google.sheets({ version: "v4", auth });
}

async function lookupActionLinkMapRow(sheets, shortCode) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: ACTION_LINK_MAP_SHEET_ID,
    range: "ActionLinkMap!A1:O10000"
  });

  const rows = rowsToObjects(res.data.values || []);

  return rows.find(row => {
    return String(row.short_code || "").trim() === String(shortCode || "").trim();
  });
}

async function lookupLeadRow(sheets, leadDataSpreadsheetId, leadId, clientId) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: leadDataSpreadsheetId,
    range: "LeadLog_Active!A1:BI10000"
  });

  const rows = rowsToObjects(res.data.values || []);

  return rows.find(row => {
    return String(row.lead_id || "").trim() === String(leadId || "").trim() &&
      String(row.client_id || "").trim() === String(clientId || "").trim();
  });
}

async function processAction(shortCode) {
  const response = await fetch(MAKE_AGENT_RESPONSE_WEBHOOK, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      short_code: shortCode,
      action_trigger_source: "ACTION_GATEWAY_CALL_BUTTON"
    })
  });

  return response.json();
}

exports.handler = async function (event) {
  try {
    const shortCode =
      event.queryStringParameters?.short_code ||
      event.queryStringParameters?.code;

    if (!shortCode) {
      return {
        statusCode: 400,
        headers: noCacheHeaders,
        body: errorPage("Invalid link")
      };
    }

    if (event.httpMethod === "POST") {
      const data = await processAction(shortCode);

      if (data.status !== "SUCCESS") {
        return {
          statusCode: 200,
          headers: noCacheHeaders,
          body: errorPage("Link expired or invalid")
        };
      }

      const phone = data.display?.phone;

      return {
        statusCode: 200,
        headers: noCacheHeaders,
        body: page(
          "Calling Lead",
          `<h1>Calling lead...</h1>
           <p>Your phone dialer should open now.</p>
           <script>
             window.location.href = "tel:${escapeHtml(phone)}";
           </script>
           <a href="tel:${escapeHtml(phone)}" style="font-size:20px;">Tap here if the dialer did not open</a>`
        )
      };
    }

    const sheets = await getSheetsClient();

    const actionRow = await lookupActionLinkMapRow(sheets, shortCode);

    if (!actionRow) {
      return {
        statusCode: 200,
        headers: noCacheHeaders,
        body: errorPage("Link expired or invalid")
      };
    }

    if (String(actionRow.is_active || "").trim().toUpperCase() !== "TRUE") {
      return {
        statusCode: 200,
        headers: noCacheHeaders,
        body: errorPage("Link expired or invalid")
      };
    }

    if (isExpired(actionRow.expires_ts_utc)) {
      return {
        statusCode: 200,
        headers: noCacheHeaders,
        body: errorPage("Link expired or invalid")
      };
    }

    if (String(actionRow.action_type || "").trim().toUpperCase() !== "CALL_NOW") {
      const data = await processAction(shortCode);

      if (data.status !== "SUCCESS") {
        return {
          statusCode: 200,
          headers: noCacheHeaders,
          body: errorPage("Link expired or invalid")
        };
      }

      return {
        statusCode: 200,
        headers: noCacheHeaders,
        body: page(
          "Action Recorded",
          `<h1>Action recorded</h1>`
        )
      };
    }

    const leadDataSpreadsheetId = String(actionRow.lead_data_spreadsheet_id || "").trim();
    const leadId = String(actionRow.lead_id || "").trim();
    const clientId = String(actionRow.client_id || "").trim();

    if (!leadDataSpreadsheetId || !leadId || !clientId) {
      return {
        statusCode: 200,
        headers: noCacheHeaders,
        body: errorPage("Link expired or invalid")
      };
    }

    const leadRow = await lookupLeadRow(sheets, leadDataSpreadsheetId, leadId, clientId);

    if (!leadRow) {
      return {
        statusCode: 200,
        headers: noCacheHeaders,
        body: errorPage("Lead not found")
      };
    }

    const phone = String(leadRow.phone || "").trim();
    const name = String(leadRow.full_name || "Lead").trim();

    if (!phone) {
      return {
        statusCode: 200,
        headers: noCacheHeaders,
        body: errorPage("Lead phone not available")
      };
    }

    return {
      statusCode: 200,
      headers: noCacheHeaders,
    body: page(
      "EngagePriority Lead",
      `<div style="max-width:420px; margin:0 auto; text-align:left; border:1px solid #ddd; border-radius:16px; padding:24px; box-shadow:0 4px 14px rgba(0,0,0,0.08);">
        <div style="text-align:center; margin-bottom:20px;">
        <div style="font-size:14px; color:#666; margin-bottom:6px;">EngagePriority Lead</div>
        <h1 style="font-size:26px; margin:0;">${escapeHtml(name)}</h1>
        </div>

        <div style="margin:22px 0; text-align:center;">
        <div style="font-size:13px; color:#666; margin-bottom:6px;">Phone</div>
        <div style="font-size:28px; font-weight:bold;">${escapeHtml(phone)}</div>
        </div>

        <form method="POST" style="margin-top:24px;">
        <input type="hidden" name="short_code" value="${escapeHtml(shortCode)}" />
        <button type="submit" style="width:100%; font-size:22px; padding:16px 20px; border:0; border-radius:12px; cursor:pointer; background:#111; color:#fff;">
            Call Lead
        </button>
        </form>

        <p style="font-size:13px; color:#666; line-height:1.4; text-align:center; margin-top:18px;">
        Pressing Call Lead records the action and opens your phone dialer.
        </p>
      </div>`
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