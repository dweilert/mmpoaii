# Document Review System — Admin Guide

This guide walks you through the complete process of setting up and running a document review cycle. Follow these steps in order for each new review.

---

## Overview

The review system lets a small committee vote on each section of a governing document (CC&Rs, Bylaws, or Rules of Conduct). There are two data files that must be prepared and loaded:

1. **Field Guide seed data** — The annotated Field Guide with classifications, "Why it's here", and "What you can do" for each section. This is what reviewers see and vote on.
2. **Governing document text** — The actual legal text from the governing document (e.g., CC&Rs). This is displayed when reviewers click "View Text" on a section.

### Complete Workflow

| Step | What | Where | Required? |
|------|------|-------|-----------|
| 1 | Parse the Field Guide (.docx → JSON) | Terminal | Yes |
| 2 | Parse the Governing Document (.docx → JSON) | Terminal | Yes |
| 3 | Upload both JSON files to S3 | Terminal (or auto with --upload) | Yes |
| 4 | Create a new review cycle | Admin Console | Yes |
| 5 | Seed the review content (Field Guide data) | Admin Console | Yes |
| 6 | Upload the document text (Governing Doc data) | Admin Console | Yes |
| 7 | Add reviewers to Cognito group | Terminal | As needed |
| 8 | Notify reviewers | Email/Slack/etc. | Yes |
| 9 | Monitor progress | Admin Console / Review Dashboard | Ongoing |
| 10 | View aggregate results | Review Dashboard | After submissions |
| 11 | Record final decisions | Admin Console → Summary Ballot | Yes |
| 12 | Start next cycle (optional) | Admin Console | If needed |

---

## Prerequisites

Before starting, ensure you have:

- [ ] **Admin access** — You must be in the `review-admins` Cognito group
- [ ] **pandoc** installed — `brew install pandoc` (used to convert Word docs)
- [ ] **Node.js** installed — Required to run the parse scripts
- [ ] **AWS CLI** configured — Required for S3 uploads (`aws configure`)
- [ ] **Field Guide** Word document (.docx) — The annotated guide for the document being reviewed
- [ ] **Governing Document** Word document (.docx) — The actual legal document (CC&Rs, Bylaws, etc.)

### Important file locations

| Item | Location |
|------|----------|
| Parse scripts | `backend/scripts/` |
| Seed data files (JSON) | `backend/seeds/` |
| S3 bucket for seeds | `s3://mmpoa-review-seeds/` |
| Admin Console | Board Portal → Review Admin Console (bottom of page) |
| Review Dashboard | Board or Homeowner Portal → Review Documents (bottom of page) |

---

## Step 1: Parse the Field Guide

The Field Guide is a Word document that contains the committee's annotations for each section of the governing document — classifications, explanations, and guidance. This is what reviewers see and vote on.

### 1a. Run the parse script

From the project root directory:

```bash
node backend/scripts/parse-field-guide.js "path/to/MMPOA_CCRs_Field_Guide_V1.docx" backend/seeds/ccrs-2026-01.json --upload
```

**Arguments:**
| Argument | Description |
|----------|-------------|
| First arg | Path to the Field Guide .docx file |
| Second arg | Output path for the JSON file (saved locally) |
| `--upload` | (Optional) Also uploads to S3 bucket `mmpoa-review-seeds` |

### 1b. Review the output

The script prints a summary to the terminal:

```
Converting MMPOA_CCRs_Field_Guide_V1.docx to markdown...
Parsing field guide content...

Articles found: 14
  Article  1 — Definitions (24 sections)
  Article  2 — Property Rights in Common Areas (3 sections)
  Article  3 — Membership and Voting Rights (6 sections)
  ...
Total sections: 140

Classification breakdown:
  best_practice: 84
  community_choice: 25
  required_by_law: 31
  (with community impact: 38)

Seed JSON written to: backend/seeds/ccrs-2026-01.json
Uploaded to S3: mmpoa-review-seeds/ccrs-2026-01.json
```

### 1c. Spot-check the JSON

Open `backend/seeds/ccrs-2026-01.json` and verify:
- Article numbers and titles are correct
- Section numbers match (watch for alphanumeric like "19A")
- Classifications are one of: `required_by_law`, `required_by_city`, `best_practice`, `community_choice`
- `whyItsHere` and `whatYouCanDo` fields have content
- `communityImpact` is present where expected (not all sections have it)

### Field Guide Word Document Format

The parse script expects this structure in the .docx file:

**Article headings** (Roman numerals):
```
Article I — Definitions
Article II — Property Rights in Common Areas
```

**Section cards** (within each article):
```
Art. I, §1 — Association
RECOMMENDED BEST PRACTICE

Why it's here: [explanation text]

What you can do: [guidance text]

Community Impact: [optional — only for some sections]

☐ Approve  ☐ Disapprove  ☐ Discuss
Notes: _______________
```

**Classification labels** — exactly one per section:
- `REQUIRED BY TEXAS LAW`
- `REQUIRED BY CITY OF AUSTIN`
- `RECOMMENDED BEST PRACTICE`
- `COMMUNITY CHOICE`

---

## Step 2: Parse the Governing Document

The governing document is the actual legal text (e.g., CC&Rs). This is displayed when reviewers click the "View Text" button on a section.

### 2a. Run the parse script

```bash
node backend/scripts/parse-governing-doc.js "path/to/MMPOA_CCRs_V1.docx" backend/seeds/ccrs-text.json --upload
```

**Arguments:**
| Argument | Description |
|----------|-------------|
| First arg | Path to the governing document .docx file |
| Second arg | Output path for the JSON file (saved locally) |
| `--upload` | (Optional) Also uploads to S3 bucket `mmpoa-review-seeds` |

### 2b. Review the output

```
Converting MMPOA_CCRs_V1.docx to markdown...
Parsing governing document...

Articles found: 14
  Article  1 — DEFINITIONS (24 sections)
  Article  2 — PROPERTY RIGHTS IN COMMON AREAS (3 sections)
  ...
Total sections: 141

Written to: backend/seeds/ccrs-text.json
Uploaded to S3: mmpoa-review-seeds/ccrs-text.json
```

**Note:** The governing document may have a slightly different section count than the Field Guide (e.g., 141 vs 140). This is expected — some sections in the legal text may not have a corresponding Field Guide entry. The "View Text" popup simply won't show for those unmatched sections.

### Governing Document Word Format

The script expects this structure:

**Article headings**:
```
# ARTICLE I - DEFINITIONS
```

**Section headings**:
```
## Section 1. "Association."
```

The full text below each section heading is captured as the legal text.

---

## Step 3: Upload Files to S3

If you used `--upload` in Steps 1 and 2, the files are already in S3. Otherwise, upload manually:

```bash
# Upload Field Guide seed data
aws s3 cp backend/seeds/ccrs-2026-01.json s3://mmpoa-review-seeds/ccrs-2026-01.json

# Upload Governing Document text
aws s3 cp backend/seeds/ccrs-text.json s3://mmpoa-review-seeds/ccrs-text.json
```

Verify the uploads:

```bash
aws s3 ls s3://mmpoa-review-seeds/
```

You should see both files listed.

---

## Step 4: Create a Review Cycle

1. Log in to the website and go to the **Board Portal**
2. Scroll to the bottom and click the **Review Admin Console** card
3. On the **Create Cycle** tab, fill in:

| Field | Description | Example |
|-------|-------------|---------|
| **Document** | Which governing document | `CCRS`, `BYLAWS`, or `CONDUCT` |
| **Cycle ID** | Unique identifier for this review round | `CCRS-2026-01` |
| **Title** | Human-readable title shown to reviewers | `CC&Rs Review — April 2026` |
| **Copy from prior cycle** | Optional — prior Cycle ID to carry forward unresolved sections | `CCRS-2025-01` |

4. Click **Create Cycle**

### Cycle ID naming convention

Use the format `DOCUMENT-YEAR-SEQUENCE`:
- `CCRS-2026-01` — first CC&Rs review in 2026
- `CCRS-2026-02` — second round (carrying forward unresolved items)
- `BYLAWS-2026-01` — first Bylaws review in 2026
- `CONDUCT-2026-01` — first Rules of Conduct review in 2026

### Carrying forward from a prior cycle

When you enter a prior Cycle ID in the "Copy from" field, the system will:
- Look at the Summary Ballot decisions from the prior cycle
- Copy forward only sections that were **NOT Approved** and **NOT Removed**
- Sections marked Disapprove or with no decision carry into the new cycle
- This lets the committee focus on unresolved items in subsequent rounds

---

## Step 5: Seed the Review Content (Field Guide Data)

This loads the Field Guide annotations — what reviewers see and vote on.

1. Go to the **Seed Content** tab in the Admin Console
2. Enter the **Cycle ID** you just created (e.g., `CCRS-2026-01`)
3. Choose the seed source:

**Option A — S3 file (recommended):**
- Select **S3 file key**
- Enter the filename: `ccrs-2026-01.json`
- This loads from the `mmpoa-review-seeds` S3 bucket

**Option B — Paste JSON (for testing):**
- Select **Paste JSON**
- Paste the full JSON content into the text area

4. Click **Seed Content**
5. You should see: `Seeded 140 sections into cycle "CCRS-2026-01"`

---

## Step 6: Upload the Document Text (Governing Doc Data)

This loads the actual legal text so reviewers can click "View Text" to see the original language.

1. Go to the **Document Text** tab in the Admin Console
2. Enter the **Cycle ID** (e.g., `CCRS-2026-01`)
3. Choose the source:

**Option A — S3 file (recommended):**
- Select **S3 file key**
- Enter the filename: `ccrs-text.json`

**Option B — Paste JSON (for testing):**
- Select **Paste JSON**
- Paste the full JSON content

4. Click **Upload Document Text**
5. You should see: `Loaded 141 sections of document text`

---

## Step 7: Add Reviewers

Each reviewer needs to be added to the `reviewers` Cognito group. Admins need to be in the `review-admins` group.

### Add a reviewer

```bash
aws cognito-idp admin-add-user-to-group \
  --user-pool-id us-east-1_tfk0ub8lC \
  --username user@example.com \
  --group-name reviewers \
  --region us-east-1
```

### Add an admin

```bash
aws cognito-idp admin-add-user-to-group \
  --user-pool-id us-east-1_tfk0ub8lC \
  --username user@example.com \
  --group-name review-admins \
  --region us-east-1
```

### List group members

```bash
aws cognito-idp list-users-in-group \
  --user-pool-id us-east-1_tfk0ub8lC \
  --group-name reviewers \
  --region us-east-1 \
  --query 'Users[*].Username' --output table
```

**Important:** Users must sign out and sign back in for group changes to take effect.

---

## Step 8: Notify Reviewers

Tell reviewers:

- Log in at **mmpoaii.org**
- Go to the **Board Portal** or **Homeowner Portal**
- Scroll to the bottom and click **Review Documents**
- Select the review cycle
- For each article, vote on every section (Approve / Disapprove / Discuss)
- Click "View Text" to see the original legal language
- Votes and notes save automatically
- When all sections are voted, click **Submit Ballot** on the articles page

---

## Step 9: Monitor Progress

As an admin, go to the Review Dashboard (click the reviewer card, not admin):
- Select the cycle to see the article list
- Each article shows colored badges: Approved (green), Disapproved (red), Discuss (yellow), Waiting (grey)
- Overall progress bar and totals are shown at the top
- **Note:** You see only your own progress until ballots are submitted

---

## Step 10: View Aggregate Results

After reviewers submit their ballots:
1. Go to the article list for the cycle
2. Click **View Aggregate Results** (appears after you submit your own ballot)
3. The aggregate view shows:
   - Vote counts per section (Approve / Disapprove / Discuss)
   - All reviewer notes
   - Unanimous approvals are highlighted

**Important:** Reviewers must submit their ballot before viewing aggregates. This prevents vote influence.

---

## Step 11: Record Final Decisions

1. Go to the **Admin Console** → **Summary Ballot** tab
2. Enter the Cycle ID and click **Load Summary**
3. For each section, you'll see aggregate votes and notes
4. Click a decision button for each section — it saves immediately

| Decision | Meaning | Carries Forward? |
|----------|---------|-----------------|
| **Approve** | Section accepted as-is | No |
| **Disapprove** | Section needs revision | Yes |
| **Remove** | Section should be deleted | No |

---

## Step 12: Start Next Cycle (if needed)

If some sections were marked Disapprove or left undecided:

1. Go to **Create Cycle** tab
2. Enter a new Cycle ID (e.g., `CCRS-2026-02`)
3. In **Copy from prior cycle**, enter the previous Cycle ID (e.g., `CCRS-2026-01`)
4. Click **Create Cycle**
5. Seed content again (Step 5) — only unresolved sections carry forward
6. Upload document text again (Step 6) — needed for the new cycle's "View Text" feature

---

## Quick Reference

| Task | Command / Location |
|------|-------------------|
| Parse Field Guide | `node backend/scripts/parse-field-guide.js input.docx output.json --upload` |
| Parse Governing Doc | `node backend/scripts/parse-governing-doc.js input.docx output.json --upload` |
| Upload to S3 manually | `aws s3 cp file.json s3://mmpoa-review-seeds/file.json` |
| List S3 files | `aws s3 ls s3://mmpoa-review-seeds/` |
| Create cycle | Admin Console → Create Cycle tab |
| Seed content | Admin Console → Seed Content tab |
| Upload doc text | Admin Console → Document Text tab |
| Add a reviewer | `aws cognito-idp admin-add-user-to-group --user-pool-id us-east-1_tfk0ub8lC --username EMAIL --group-name reviewers --region us-east-1` |
| Add an admin | Same command with `--group-name review-admins` |
| List reviewers | `aws cognito-idp list-users-in-group --user-pool-id us-east-1_tfk0ub8lC --group-name reviewers --region us-east-1` |
| View results | Admin Console → Summary Ballot tab |
| Start next round | Admin Console → Create Cycle → enter prior Cycle ID in "Copy from" |

---

## Troubleshooting

**"pandoc: command not found"**
- Install pandoc: `brew install pandoc`

**Parse script shows 0 articles or wrong count**
- Verify the Word document follows the expected format (see Field Guide / Governing Doc format sections above)
- Try running pandoc manually to inspect the markdown: `pandoc input.docx -t markdown -o debug.md`
- Check for missing classification labels or "Why it's here" fields

**"Failed to fetch" in Admin Console**
- Sign out and sign back in to refresh your authentication token
- Check that you are in the `review-admins` Cognito group

**Reviewer can't see the Review Documents section**
- They must be in the `reviewers` Cognito group
- They must sign out and sign back in after being added to the group

**"Cycle already exists" error**
- Each Cycle ID must be unique. Use a different ID (increment the sequence number)

**Seed says "0 sections seeded"**
- Verify the JSON file has an `articles` array with `sections` inside each article
- Check the S3 key matches the uploaded file name exactly

**"Document text not available for this section"**
- The document text has not been uploaded for this cycle
- Go to Admin Console → Document Text tab and upload the governing document JSON
- Make sure you use the same Cycle ID

**Votes not showing in article list or aggregate**
- This was a known bug (URL encoding issue with `#` in section IDs) that has been fixed
- If you see stale data, votes may need to be re-cast on affected sections

**S3 upload fails with "access denied"**
- Ensure your AWS CLI is configured with credentials that have access to the `mmpoa-review-seeds` bucket
- Run `aws sts get-caller-identity` to verify your credentials

---

## Architecture Notes

### Data stored in DynamoDB (`mmpoa-reviews` table)

| Data | PK | SK Pattern |
|------|-----|------------|
| Cycle metadata | `CYCLE#{cycleId}` | `META` |
| Section content (Field Guide) | `CYCLE#{cycleId}` | `CONTENT#ART-{nn}#SEC-{nn}` |
| Document text (legal) | `CYCLE#{cycleId}` | `DOCTEXT#ART-{nn}#SEC-{nn}` |
| Reviewer votes | `CYCLE#{cycleId}` | `VOTE#ART-{nn}#SEC-{nn}#USER#{sub}` |
| Ballot status | `CYCLE#{cycleId}` | `BALLOT#USER#{sub}` |
| Admin decisions | `CYCLE#{cycleId}` | `SUMMARY#ART-{nn}#SEC-{nn}` |

### Two parallel data paths

```
Field Guide (.docx)                    Governing Document (.docx)
       |                                        |
  parse-field-guide.js                  parse-governing-doc.js
       |                                        |
  seed JSON → S3                       text JSON → S3
       |                                        |
  Admin Console: Seed Content          Admin Console: Document Text
       |                                        |
  cycle-seed Lambda                    doctext-save Lambda
       |                                        |
  CONTENT# items in DynamoDB           DOCTEXT# items in DynamoDB
       |                                        |
  Reviewer sees annotations            Reviewer clicks "View Text"
  and votes on each section            to see original legal language
```
