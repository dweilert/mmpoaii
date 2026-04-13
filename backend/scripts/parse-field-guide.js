#!/usr/bin/env node
'use strict';

/**
 * parse-field-guide.js
 *
 * Converts a Field Guide Word document (.docx) into seed JSON for the
 * MMPOA Document Review system.
 *
 * Prerequisites:
 *   - pandoc must be installed (brew install pandoc)
 *
 * Usage:
 *   node backend/scripts/parse-field-guide.js <input.docx> [output.json] [--upload]
 *
 * Examples:
 *   # Convert and write JSON locally
 *   node backend/scripts/parse-field-guide.js "MMPOA_CCRs_Field_Guide_V1.docx" backend/seeds/ccrs-2026-01.json
 *
 *   # Convert and also upload to S3 seed bucket
 *   node backend/scripts/parse-field-guide.js "MMPOA_CCRs_Field_Guide_V1.docx" backend/seeds/ccrs-2026-01.json --upload
 *
 *   # If output is omitted, prints JSON to stdout
 *   node backend/scripts/parse-field-guide.js "MMPOA_CCRs_Field_Guide_V1.docx" > seed.json
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Strip markdown bold/italic markers and trim */
function clean(text) {
  return (text || '')
    .replace(/\*\*/g, '')       // bold
    .replace(/\*/g, '')         // italic
    .replace(/\\"/g, '"')       // escaped quotes from pandoc
    .replace(/---/g, '—')       // em-dash
    .replace(/--/g, '–')        // en-dash
    .trim();
}

/** Map classification label to key */
function classifyLabel(label) {
  const upper = label.toUpperCase().trim();
  if (upper.includes('REQUIRED BY TEXAS LAW'))     return 'required_by_law';
  if (upper.includes('REQUIRED BY CITY'))          return 'required_by_city';
  if (upper.includes('RECOMMENDED BEST PRACTICE')) return 'best_practice';
  if (upper.includes('COMMUNITY CHOICE'))          return 'community_choice';
  return 'best_practice'; // fallback
}

/** Convert Roman numeral to number */
function romanToInt(roman) {
  const map = { I:1, V:5, X:10, L:50, C:100, D:500, M:1000 };
  let result = 0;
  const upper = roman.toUpperCase();
  for (let i = 0; i < upper.length; i++) {
    const curr = map[upper[i]] || 0;
    const next = map[upper[i + 1]] || 0;
    result += curr < next ? -curr : curr;
  }
  return result;
}

/** Parse section number — handles integers and alphanumeric like "19A" */
function parseSectionNumber(str) {
  const trimmed = str.trim();
  const asInt = parseInt(trimmed, 10);
  // If the string is purely numeric, return a number
  if (String(asInt) === trimmed) return asInt;
  // Otherwise return the string (e.g. "19A")
  return trimmed;
}

// ── Main parser ──────────────────────────────────────────────────────────────

function parseFieldGuide(markdown) {
  const lines = markdown.split('\n');
  const articles = [];
  let currentArticle = null;
  let currentSection = null;

  // State machine: what we're collecting
  let collectingField = null; // 'why', 'what', 'impact', or null

  // Regex patterns
  // Article heading:  ## Article I --- Definitions
  const articleRe = /^##\s+Article\s+([IVXLCDM]+)\s+---\s+(.+)$/;
  // Section card:  **Art. I, §1 --- Association**
  const sectionRe = /\*\*Art\.\s+[IVXLCDM]+,\s+§(\S+)\s+---\s+(.+?)\*\*/;
  // Classification line:  **RECOMMENDED BEST PRACTICE**
  const classRe = /^\s*\*\*(REQUIRED BY TEXAS LAW|REQUIRED BY CITY OF AUSTIN|RECOMMENDED BEST PRACTICE|COMMUNITY CHOICE)\*\*/;
  // Field labels
  const whyRe = /^\*\*Why it's here:\*\*\s*(.*)$/;
  const whatRe = /^\*\*What you can do:\*\*\s*(.*)$/;
  const impactRe = /^\*\*Community Impact:\*\*\s*(.*)$/;
  // Lines to skip
  const checkboxRe = /☐\s*(Approve|Disapprove|Discuss)/;
  const notesRe = /\*\*Notes:\*\*/;
  const hrRe = /^\s*-{5,}\s*$/;

  function finishSection() {
    if (currentSection && currentArticle) {
      // Clean all fields
      currentSection.whyItsHere = clean(currentSection.whyItsHere);
      currentSection.whatYouCanDo = clean(currentSection.whatYouCanDo);
      if (currentSection.communityImpact) {
        currentSection.communityImpact = clean(currentSection.communityImpact);
      }
      currentArticle.sections.push(currentSection);
    }
    currentSection = null;
    collectingField = null;
  }

  function finishArticle() {
    finishSection();
    if (currentArticle) {
      articles.push(currentArticle);
    }
    currentArticle = null;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // New article heading
    const artMatch = line.match(articleRe);
    if (artMatch) {
      finishArticle();
      currentArticle = {
        articleNumber: romanToInt(artMatch[1]),
        articleTitle: clean(artMatch[2]),
        sections: []
      };
      continue;
    }

    // Skip lines before first article
    if (!currentArticle) continue;

    // Section card line
    const secMatch = line.match(sectionRe);
    if (secMatch) {
      finishSection();
      currentSection = {
        sectionNumber: parseSectionNumber(secMatch[1]),
        sectionTitle: clean(secMatch[2]),
        classification: 'best_practice',
        whyItsHere: '',
        whatYouCanDo: ''
      };
      collectingField = null;
      continue;
    }

    if (!currentSection) continue;

    // Classification
    const classMatch = line.match(classRe);
    if (classMatch) {
      currentSection.classification = classifyLabel(classMatch[1]);
      continue;
    }

    // Skip decorative lines, checkboxes, notes
    if (hrRe.test(line)) continue;
    if (checkboxRe.test(line)) continue;
    if (notesRe.test(line)) continue;
    if (line.match(/^>\s*$/) || line.match(/^>\s*\\_/)) continue;
    if (line.trim() === '') {
      // Blank line ends field collection only if we have content
      continue;
    }

    // "Why it's here" field
    const whyMatch = line.match(whyRe);
    if (whyMatch) {
      collectingField = 'why';
      currentSection.whyItsHere = whyMatch[1];
      continue;
    }

    // "What you can do" field
    const whatMatch = line.match(whatRe);
    if (whatMatch) {
      collectingField = 'what';
      currentSection.whatYouCanDo = whatMatch[1];
      continue;
    }

    // "Community Impact" field
    const impactMatch = line.match(impactRe);
    if (impactMatch) {
      collectingField = 'impact';
      currentSection.communityImpact = impactMatch[1];
      continue;
    }

    // Continuation lines — append to current field if we're collecting
    if (collectingField && !line.startsWith('>') && line.trim()) {
      const trimmed = line.trim();
      if (collectingField === 'why') {
        currentSection.whyItsHere += ' ' + trimmed;
      } else if (collectingField === 'what') {
        currentSection.whatYouCanDo += ' ' + trimmed;
      } else if (collectingField === 'impact') {
        currentSection.communityImpact += ' ' + trimmed;
      }
    }
  }

  // Finish last article/section
  finishArticle();

  return { articles };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2).filter(a => a !== '--upload');
  const doUpload = process.argv.includes('--upload');

  if (args.length < 1) {
    console.error('Usage: node parse-field-guide.js <input.docx> [output.json] [--upload]');
    console.error('');
    console.error('Converts a Field Guide Word document into seed JSON for the');
    console.error('Document Review system.');
    console.error('');
    console.error('Options:');
    console.error('  --upload    Also upload the JSON to the S3 seed bucket');
    console.error('');
    console.error('Examples:');
    console.error('  node parse-field-guide.js "CCRs_Field_Guide_V1.docx" seeds/ccrs-2026-01.json');
    console.error('  node parse-field-guide.js "CCRs_Field_Guide_V1.docx" seeds/ccrs-2026-01.json --upload');
    process.exit(1);
  }

  const inputPath = path.resolve(args[0]);
  const outputPath = args[1] ? path.resolve(args[1]) : null;

  // Validate input
  if (!fs.existsSync(inputPath)) {
    console.error('Error: Input file not found: ' + inputPath);
    process.exit(1);
  }

  if (!inputPath.endsWith('.docx')) {
    console.error('Error: Input must be a .docx file');
    process.exit(1);
  }

  // Check pandoc
  try {
    execSync('which pandoc', { stdio: 'pipe' });
  } catch {
    console.error('Error: pandoc is not installed. Install with: brew install pandoc');
    process.exit(1);
  }

  // Convert docx → markdown
  console.error('Converting ' + path.basename(inputPath) + ' to markdown...');
  const markdown = execSync(
    'pandoc ' + JSON.stringify(inputPath) + ' -t markdown --wrap=none',
    { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
  );

  // Parse
  console.error('Parsing field guide content...');
  const seed = parseFieldGuide(markdown);

  // Report
  let totalSections = 0;
  console.error('');
  console.error('Articles found: ' + seed.articles.length);
  for (const art of seed.articles) {
    console.error('  Article ' + String(art.articleNumber).padStart(2) +
      ' — ' + art.articleTitle + ' (' + art.sections.length + ' sections)');
    totalSections += art.sections.length;
  }
  console.error('');
  console.error('Total sections: ' + totalSections);

  // Classification breakdown
  const counts = {};
  for (const art of seed.articles) {
    for (const sec of art.sections) {
      counts[sec.classification] = (counts[sec.classification] || 0) + 1;
    }
  }
  console.error('');
  console.error('Classification breakdown:');
  for (const [cls, count] of Object.entries(counts)) {
    console.error('  ' + cls + ': ' + count);
  }

  // Sections with community impact
  let impactCount = 0;
  for (const art of seed.articles) {
    for (const sec of art.sections) {
      if (sec.communityImpact) impactCount++;
    }
  }
  console.error('  (with community impact: ' + impactCount + ')');

  // Output
  const json = JSON.stringify(seed, null, 2);

  if (outputPath) {
    // Ensure output directory exists
    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(outputPath, json + '\n');
    console.error('');
    console.error('Seed JSON written to: ' + outputPath);

    // Upload to S3 if requested
    if (doUpload) {
      const s3Key = path.basename(outputPath);
      const bucket = 'mmpoa-review-seeds';
      console.error('Uploading to s3://' + bucket + '/' + s3Key + '...');
      try {
        execSync(
          'aws s3 cp ' + JSON.stringify(outputPath) +
          ' s3://' + bucket + '/' + s3Key +
          ' --region us-east-1',
          { stdio: 'inherit' }
        );
        console.error('Upload complete.');
      } catch (err) {
        console.error('S3 upload failed. Make sure AWS CLI is configured and the bucket exists.');
        process.exit(1);
      }
    }
  } else {
    // Write to stdout
    process.stdout.write(json + '\n');
  }
}

main();
