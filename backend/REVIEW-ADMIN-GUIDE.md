# Document Review System — Admin Guide

This guide walks you through the complete process of setting up and running a document review cycle, from preparing the Field Guide to recording final decisions.

---

## Overview

The review system lets a small committee vote on each section of a governing document (CC&Rs, Bylaws, or Rules of Conduct). The workflow is:

1. **Prepare** — Convert a Field Guide Word document into seed data
2. **Create** — Create a new review cycle in the Admin Console
3. **Seed** — Load the section content into the cycle
4. **Review** — Reviewers vote on each section (Approve / Disapprove / Discuss)
5. **Submit** — Each reviewer submits their completed ballot
6. **Aggregate** — View combined results across all reviewers
7. **Decide** — Record final decisions on the Summary Ballot
8. **Next Cycle** — Optionally carry forward unresolved sections into a new cycle

---

## Prerequisites

- You must be in the **review-admins** Cognito group
- Reviewers must be in the **reviewers** Cognito group
- **pandoc** must be installed on your computer (`brew install pandoc`)
- **AWS CLI** must be configured (for S3 upload)
- The Field Guide Word document must follow the standard format (see "Field Guide Format" below)

### Adding users to groups

To add a user to the reviewers or review-admins group:

```bash
aws cognito-idp admin-add-user-to-group \
  --user-pool-id us-east-1_tfk0ub8lC \
  --username user@example.com \
  --group-name reviewers \
  --region us-east-1
```

Replace `reviewers` with `review-admins` for admin access. Users must sign out and sign back in for group changes to take effect.

---

## Step 1: Prepare the Seed Data

The Field Guide Word document (.docx) must be converted into JSON before it can be loaded into the review system. A script in the repo handles this automatically.

### Run the conversion script

From the project root directory:

```bash
node backend/scripts/parse-field-guide.js "path/to/Field_Guide.docx" backend/seeds/my-cycle.json
```

The script will:
- Convert the Word document to markdown using pandoc
- Parse all articles, sections, classifications, and field content
- Write the seed JSON file
- Print a summary showing article counts and classification breakdown

Example output:
```
Converting MMPOA_CCRs_Field_Guide_V1.docx to markdown...
Parsing field guide content...

Articles found: 14
  Article  1 — Definitions (24 sections)
  Article  2 — Property Rights in Common Areas (3 sections)
  ...
Total sections: 140

Classification breakdown:
  best_practice: 84
  community_choice: 25
  required_by_law: 31
  (with community impact: 38)

Seed JSON written to: backend/seeds/my-cycle.json
```

### Upload to S3 (recommended for large documents)

Add the `--upload` flag to also upload the JSON to the S3 seed bucket:

```bash
node backend/scripts/parse-field-guide.js "path/to/Field_Guide.docx" backend/seeds/ccrs-2026-01.json --upload
```

This uploads the file to `s3://mmpoa-review-seeds/ccrs-2026-01.json` so you can reference it by key in the Admin Console.

### Verify the output

Open the JSON file and spot-check a few sections to confirm:
- Article numbers and titles are correct
- Section numbers match (watch for alphanumeric like "19A")
- Classifications are mapped correctly
- "Why it's here" and "What you can do" text is complete
- "Community Impact" is present where expected

---

## Step 2: Create a Review Cycle

1. Log in to the website and go to the **Board Portal** or **Homeowner Portal**
2. Scroll to the bottom and click the **Review Admin Console** card
3. On the **Create Cycle** tab, fill in:

| Field | Description | Example |
|-------|-------------|---------|
| **Document** | Which governing document | `CCRS`, `BYLAWS`, or `CONDUCT` |
| **Cycle ID** | Unique identifier for this review round | `CCRS-2026-01` |
| **Title** | Human-readable title shown to reviewers | `CC&Rs Review — April 2026` |
| **Copy from prior cycle** | Optional — enter a prior Cycle ID to carry forward unresolved sections | `CCRS-2025-01` |

4. Click **Create Cycle**

### Cycle ID naming convention

Use the format `DOCUMENT-YEAR-SEQUENCE`:
- `CCRS-2026-01` — first CC&Rs review in 2026
- `CCRS-2026-02` — second round (after carrying forward)
- `BYLAWS-2026-01` — first Bylaws review in 2026
- `CONDUCT-2026-01` — first Rules of Conduct review in 2026

### Carrying forward from a prior cycle

When you enter a prior Cycle ID in the "Copy from" field, the system will:
- Look at the Summary Ballot decisions from the prior cycle
- Copy forward only sections that were **not Approved** and **not Removed**
- Sections marked Disapprove or with no decision are carried into the new cycle
- This lets the committee focus on unresolved items in subsequent rounds

---

## Step 3: Seed the Content

After creating the cycle, load the section content:

1. Go to the **Seed Content** tab in the Admin Console
2. Enter the **Cycle ID** you just created (e.g., `CCRS-2026-01`)
3. Choose the seed source:

**Option A — S3 file (recommended for large documents):**
- Select **S3 file key**
- Enter the filename: `ccrs-2026-01.json`
- This loads from the `mmpoa-review-seeds` S3 bucket

**Option B — Paste JSON (for small documents or testing):**
- Select **Paste JSON**
- Paste the full JSON content into the text area

4. Click **Seed Content**
5. You should see a success message like: `Seeded 140 sections into cycle "CCRS-2026-01"`

---

## Step 4: Notify Reviewers

Once the cycle is seeded, reviewers can begin voting. Let them know:

- Log in to the portal (Board or Homeowner)
- Scroll to the bottom and click the **Document Review** card
- Select the review cycle
- Work through each article, voting on every section
- Votes and notes are saved automatically — no need to click "save"
- When all sections are voted, click **Submit Ballot** on the articles page

There is no deadline built into the system. Communicate deadlines separately.

---

## Step 5: Monitor Progress

As an admin, you can track reviewer progress:

- Go to the **Document Review Dashboard** (click the reviewer card, not admin)
- Select the cycle to see the article list
- The progress bars show how many sections have been voted on
- Note: progress shown is for your own ballot — you cannot see other reviewers' progress until they submit

---

## Step 6: View Aggregate Results

After reviewers submit their ballots:

1. Go to the article list for the cycle
2. Click **View Aggregate Results** (appears after you submit your own ballot)
3. The aggregate view shows:
   - Vote counts per section (Approve / Disapprove / Discuss)
   - Unanimous approvals are highlighted
   - All reviewer notes are listed

Reviewers must submit their ballot before viewing aggregate results. This prevents vote influence. Admins can view aggregates at any time.

---

## Step 7: Record Final Decisions

1. Go to the **Admin Console** → **Summary Ballot** tab
2. Enter the Cycle ID and click **Load Summary**
3. For each section, you'll see:
   - The aggregate vote counts from all reviewers
   - Reviewer notes
   - Three decision buttons: **Approve**, **Disapprove**, **Remove**
4. Click a decision button for each section — it saves immediately

### Decision meanings

| Decision | What it means |
|----------|---------------|
| **Approve** | Section is accepted as-is. It will NOT carry forward to the next cycle. |
| **Disapprove** | Section needs revision. It WILL carry forward to the next cycle. |
| **Remove** | Section should be deleted from the document. It will NOT carry forward. |

---

## Step 8: Start the Next Cycle (if needed)

If some sections were marked Disapprove (or left undecided), start a new cycle:

1. Go to **Create Cycle** tab
2. Fill in the new Cycle ID (e.g., `CCRS-2026-02`)
3. In the **Copy from prior cycle** field, enter the previous Cycle ID (e.g., `CCRS-2026-01`)
4. Click **Create Cycle**

Only unresolved sections carry forward. You can then update the seed data for those sections if the document has been revised, or let reviewers vote on the same content again.

---

## Field Guide Format

The parse script expects a Word document (.docx) with this structure:

### Article headings

```
Article I — Definitions
Article II — Property Rights in Common Areas
```

Articles use Roman numerals (I, II, III...) and are separated by `---` from the title.

### Section cards

Each section must have:

```
Art. I, §1 — Association
RECOMMENDED BEST PRACTICE

Why it's here: [explanation text]

What you can do: [guidance text in italics]

Community Impact: [optional — only when applicable]

☐ Approve  ☐ Disapprove  ☐ Discuss
Notes: _______________
```

### Classification labels

Use exactly one of these labels per section:
- `REQUIRED BY TEXAS LAW`
- `REQUIRED BY CITY OF AUSTIN`
- `RECOMMENDED BEST PRACTICE`
- `COMMUNITY CHOICE`

### Section numbering

Section numbers are typically integers (1, 2, 3...) but alphanumeric values like `19A` are supported.

---

## Quick Reference

| Task | Where | What to do |
|------|-------|------------|
| Convert Field Guide | Terminal | `node backend/scripts/parse-field-guide.js input.docx output.json --upload` |
| Create cycle | Admin Console → Create Cycle | Fill in Document, Cycle ID, Title |
| Seed content | Admin Console → Seed Content | Enter Cycle ID + S3 key |
| Add a reviewer | Terminal | `aws cognito-idp admin-add-user-to-group --user-pool-id us-east-1_tfk0ub8lC --username email --group-name reviewers --region us-east-1` |
| Add an admin | Terminal | Same command but `--group-name review-admins` |
| View results | Admin Console → Summary Ballot | Enter Cycle ID → Load Summary |
| Start next round | Admin Console → Create Cycle | Enter prior Cycle ID in "Copy from" field |

---

## Troubleshooting

**"Failed to fetch" in Admin Console**
- Sign out and sign back in to refresh your authentication token
- Check that you are in the `review-admins` Cognito group

**Reviewer can't see the Review Documents section**
- They must be in the `reviewers` Cognito group
- They must sign out and sign back in after being added to the group

**"Cycle already exists" error**
- Each Cycle ID must be unique. Use a different ID (e.g., increment the sequence number)

**Seed says "0 sections seeded"**
- Verify the JSON file has an `articles` array with `sections` inside each article
- Check the S3 key matches the uploaded file name exactly

**Parse script shows wrong section count**
- Verify the Word document follows the expected format (see "Field Guide Format" above)
- Check for missing classification labels or "Why it's here" fields
