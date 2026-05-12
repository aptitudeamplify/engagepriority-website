const { google } = require("googleapis");

const MAKE_INITIAL_RESPONSE_WEBHOOK =
  process.env.MAKE_INITIAL_RESPONSE_WEBHOOK_URL;

const MAKE_OUTCOME_RESPONSE_WEBHOOK =
  process.env.MAKE_OUTCOME_RESPONSE_WEBHOOK_URL;

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

  const rawRows = res.data.values || [];
  const rows = rowsToObjects(rawRows);

  const foundIndex = rows.findIndex(row => {
    return String(row.short_code || "").trim() === String(shortCode || "").trim();
  });

  if (foundIndex === -1) {
    return null;
  }

  return {
    ...rows[foundIndex],
    _sheet_row_number: foundIndex + 2
  };
}

async function claimActionLinkForDispatch(sheets, actionRow, claimedTsUtc) {
  if (!actionRow?._sheet_row_number) {
    throw new Error("Cannot claim action link without sheet row number.");
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId: ACTION_LINK_MAP_SHEET_ID,
    range: `ActionLinkMap!L${actionRow._sheet_row_number}`,
    valueInputOption: "RAW",
    requestBody: {
      values: [[claimedTsUtc]]
    }
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

async function processAction({
  shortCode,
  selectedAction,
  gatewayContext
}) {

  let webhookUrl = null;

  if (gatewayContext === "INITIAL_RESPONSE_GATEWAY") {
    webhookUrl = MAKE_INITIAL_RESPONSE_WEBHOOK;
  } else if (gatewayContext === "OUTCOME_GATEWAY") {
    webhookUrl = MAKE_OUTCOME_RESPONSE_WEBHOOK;
  }

  if (!webhookUrl) {
    throw new Error(`Unsupported gateway context: ${gatewayContext}`);
  }

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      short_code: shortCode,
      gateway_context: gatewayContext,
      selected_action: selectedAction,
      action_trigger_source: "ACTION_GATEWAY_BUTTON",
      agent_action_ts_utc: new Date().toISOString()
    })
  });

  const text = await response.text();

  return {
    ok: response.ok,
    statusCode: response.status,
    body: text
  };
}

function validateActiveGatewayRow(actionRow) {
  if (!actionRow) {
    return false;
  }

  if (String(actionRow.is_active || "").trim().toUpperCase() !== "TRUE") {
    return false;
  }

  if (String(actionRow.used_ts_utc || "").trim()) {
    return false;
  }

  if (isExpired(actionRow.expires_ts_utc)) {
    return false;
  }
  return true;
}

exports.handler = async function (event) {
  try {
    const shortCode =
     event.queryStringParameters?.short_code ||
     event.path?.split("/").filter(Boolean).pop();

    if (!shortCode) {
      return {
        statusCode: 400,
        headers: noCacheHeaders,
        body: errorPage("Invalid link")
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

    const gatewayContext = String(
        actionRow.gateway_context || ""
    ).trim().toUpperCase();

    if (
    gatewayContext !== "INITIAL_RESPONSE_GATEWAY" &&
    gatewayContext !== "OUTCOME_GATEWAY"
    ) {
        if (String(actionRow.is_active || "").trim().toUpperCase() !== "TRUE") {
            return {
                statusCode: 200,
                headers: noCacheHeaders,
                body: errorPage("Link already used or expired")
            };
        }

        if (String(actionRow.used_ts_utc || "").trim()) {
            return {
                statusCode: 200,
                headers: noCacheHeaders,
                body: errorPage("Link already used or expired")
            };
        }

        if (isExpired(actionRow.expires_ts_utc)) {
            return {
                statusCode: 200,
                headers: noCacheHeaders,
                body: errorPage("Link already used or expired")
            };
        }

        const claimedTsUtc = new Date().toISOString();

        await claimActionLinkForDispatch(
            sheets,
            actionRow,
            claimedTsUtc
        );

        const storedSelectedAction = String(
            actionRow.selected_action || ""
        ).trim().toUpperCase();

        if (!storedSelectedAction) {
            return {
                statusCode: 200,
                headers: noCacheHeaders,
                body: errorPage("Link expired or invalid")
            };
        }

        const data = await processAction({
            shortCode,
            selectedAction: storedSelectedAction,
            gatewayContext
        });

        if (!data.ok) {
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
            `<h1>Action Recorded</h1>
            <p>Your response has been received successfully.</p>`
            )
      };
    }

    if (!validateActiveGatewayRow(actionRow)) {
      return {
        statusCode: 200,
        headers: noCacheHeaders,
        body: errorPage("Link expired or invalid")
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

    if (event.httpMethod === "POST") {
        const selectedAction = String(
            event.queryStringParameters?.selected_action || ""
        ).trim().toUpperCase();
                
      if (!selectedAction) {
        return {
            statusCode: 400,
            headers: noCacheHeaders,
            body: errorPage("Missing action")
        };
       } 

       const allowedActions = [
        "CALL_NOW",
        "REMIND_ME_5_MIN",
        "REASSIGN",
        "NO_ANSWER",
        "CONTACTED_SET_APPOINTMENT",
        "CONTACTED_NOT_INTERESTED"
       ];

       if (!allowedActions.includes(selectedAction)) {
         return {
            statusCode: 400,
            headers: noCacheHeaders,
            body: errorPage("Invalid action")
         };
       }

       const freshActionRow = await lookupActionLinkMapRow(sheets, shortCode);

      if (!validateActiveGatewayRow(freshActionRow)) {
        return {
          statusCode: 200,
          headers: noCacheHeaders,
          body: errorPage("Link already used or expired")
        };
      }

    const claimedTsUtc = new Date().toISOString();

    await claimActionLinkForDispatch(
        sheets,
        freshActionRow,
        claimedTsUtc
    );

    const data = await processAction({
        shortCode,
        selectedAction,
        gatewayContext
    });

      if (!data.ok) {
        return {
          statusCode: 200,
          headers: noCacheHeaders,
          body: errorPage("Link expired or invalid")
        };
      }

      if (selectedAction !== "CALL_NOW") {
        return {
            statusCode: 200,
            headers: noCacheHeaders,
            body: page(
            "Action Recorded",
            `<h1>Action Recorded</h1>
            <p>Your response has been received successfully.</p>`
            )
        };
      }

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

if (gatewayContext === "OUTCOME_GATEWAY") {

  return {
    statusCode: 200,
    headers: noCacheHeaders,
    body: page(
      "Lead Outcome",
      `<div style="max-width:420px; margin:0 auto; text-align:left; border:1px solid #ddd; border-radius:16px; padding:24px; box-shadow:0 4px 14px rgba(0,0,0,0.08);">

        <div style="text-align:center; margin-bottom:20px;">
          <div style="font-size:14px; color:#666; margin-bottom:6px;">Lead Outcome</div>
          <h1 style="font-size:26px; margin:0;">${escapeHtml(name)}</h1>
        </div>

        <div style="margin:22px 0; text-align:center;">
          <div style="font-size:13px; color:#666; margin-bottom:6px;">Phone</div>
          <div style="font-size:28px; font-weight:bold;">${escapeHtml(phone)}</div>
        </div>

        <form method="POST" action="/.netlify/functions/handle-action?short_code=${escapeHtml(shortCode)}&selected_action=CONTACTED_SET_APPOINTMENT" style="margin-top:24px;">
          <button type="submit" style="width:100%; font-size:18px; padding:14px 18px; border:0; border-radius:12px; cursor:pointer; background:#111; color:#fff;">
            Contacted - Appointment Set
          </button>
        </form>

        <form method="POST" action="/.netlify/functions/handle-action?short_code=${escapeHtml(shortCode)}&selected_action=CONTACTED_NOT_INTERESTED" style="margin-top:12px;">
          <button type="submit" style="width:100%; font-size:18px; padding:14px 18px; border:1px solid #ccc; border-radius:12px; cursor:pointer; background:#fff; color:#111;">
            Contacted - Not Interested
          </button>
        </form>

        <form method="POST" action="/.netlify/functions/handle-action?short_code=${escapeHtml(shortCode)}&selected_action=NO_ANSWER" style="margin-top:12px;">
          <button type="submit" style="width:100%; font-size:18px; padding:14px 18px; border:1px solid #ccc; border-radius:12px; cursor:pointer; background:#fff; color:#111;">
            No Answer
          </button>
        </form>

        <form method="POST" action="/.netlify/functions/handle-action?short_code=${escapeHtml(shortCode)}&selected_action=REASSIGN" style="margin-top:12px;">
          <button type="submit" style="width:100%; font-size:18px; padding:14px 18px; border:1px solid #ccc; border-radius:12px; cursor:pointer; background:#fff; color:#111;">
            Reassign
          </button>
        </form>

      </div>`
    )
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

          <form method="POST" action="/.netlify/functions/handle-action?short_code=${escapeHtml(shortCode)}&selected_action=CALL_NOW" style="margin-top:24px;">
            <button type="submit" style="width:100%; font-size:22px; padding:16px 20px; border:0; border-radius:12px; cursor:pointer; background:#111; color:#fff;">
              Call Lead
            </button>
          </form>
            
          <form method="POST" action="/.netlify/functions/handle-action?short_code=${escapeHtml(shortCode)}&selected_action=REMIND_ME_5_MIN" style="margin-top:12px;">
            <button type="submit" style="width:100%; font-size:18px; padding:14px 18px; border:1px solid #ccc; border-radius:12px; cursor:pointer; background:#fff; color:#111;">
              Remind Me In 5 Minutes
            </button>
          </form>

          <form method="POST" action="/.netlify/functions/handle-action?short_code=${escapeHtml(shortCode)}&selected_action=REASSIGN" style="margin-top:12px;">
            <button type="submit" style="width:100%; font-size:18px; padding:14px 18px; border:1px solid #ccc; border-radius:12px; cursor:pointer; background:#fff; color:#111;">
              Reassign
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

