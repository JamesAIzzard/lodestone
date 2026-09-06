---
schema: 1
account_uid: imap:outlook.office365.com:993:james@example.com
message_key: uid:INBOX:1234567:8901
message_id: <abc@example.com>
in_reply_to: <xyz@example.com>
references:
  - <xyz@example.com>
subject: '# quoted: "value"

  folders: ["x"]'
from: Izzard, James <james@example.com>
to:
  - James Izzard <james@example.com>
cc: []
date: 2026-09-01T09:14:00Z
received_at: 2026-09-01T09:14:07Z
folders:
  - INBOX
seen: true
flagged: false
attachments: []
body_status: complete
---
Subject: # quoted: "value"
folders: ["x"]
From: Izzard, James <james@example.com>
To: James Izzard <james@example.com>
Date: 2026-09-01T09:14:00Z

Plain body.
