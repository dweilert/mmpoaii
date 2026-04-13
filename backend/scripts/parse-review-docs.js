#!/usr/bin/env node
'use strict';

/**
 * parse-review-docs.js
 *
 * Parses BOTH the Field Guide and the Governing Document together,
 * validates that they match (same articles/sections), and produces
 * two output JSON files with a shared documentSetId for integrity.
 *
 * Prerequisites:
 *   - pandoc must be installed (brew install pandoc)
 *
 * Usage:
 *   node backend/scripts/parse-review-docs.js \
 *     --field-guide "path/to/Field_Guide.docx" \
 *     --governing-doc "path/to/CCRs_V1.docx" \
 *     --output-dir backend/seeds \
 *     --name ccrs-2026-01 \
 *     [--upload]
 *
 * Outputs:
 *   backend/seeds/ccrs-2026-01-seed.json    (Field Guide → review content)
 *   backend/seeds/ccrs-2026-01-text.json    (Governing Doc → legal text)
 *
 * Both files share a documentSetId that the Admin Console validates
 * before allowing content to be loaded.
 */

const { execSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ── Shared Helpers ─────────────────────────────────────────────────────────

function clean(text) {
  return (text || '')
    .replace(/\*\*/g, '')
    .replace(/\*/g, '')
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .replace(/\\\[/g, '[')
    .replace(/\\\]/g, ']')
    .replace(/---/g, '—')
    .replace(/--/g, '–')
    .trim();
}

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

function parseSectionNumber(str) {
  const trimmed = str.trim().replace(/\.$/, '');
  const asInt = parseInt(trimmed, 10);
  if (String(asInt) === trimmed) return asInt;
  return trimmed;
}

function classifyLabel(label) {
  const upper = label.toUpperCase().trim();
  if (upper.includes('REQUIRED BY TEXAS LAW'))     return 'required_by_law';
  if (upper.includes('REQUIRED BY CITY'))          return 'required_by_city';
  if (upper.includes('RECOMMENDED BEST PRACTICE')) return 'best_practice';
  if (upper.includes('COMMUNITY CHOICE'))          return 'community_choice';
  return 'best_practice';
}

function convertToMarkdown(docxPath) {
  return execSync(
    'pandoc ' + JSON.stringify(docxPath) + ' -t markdown --wrap=none',
    { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
  );
}

/** Build a set key like "1-1", "1-19A" for comparison */
function sectionKey(articleNumber, sectionNumber) {
  return articleNumber + '-' + sectionNumber;
}

// ── Field Guide Parser ─────────────────────────────────────────────────────

function parseFieldGuide(markdown) {
  const lines = markdown.split('\n');
  const articles = [];
  let currentArticle = null;
  let currentSection = null;
  let collectingField = null;

  const articleRe = /^##\s+Article\s+([IVXLCDM]+)\s+---\s+(.+)$/;
  const sectionRe = /\*\*Art\.\s+[IVXLCDM]+,\s+§(\S+)\s+---\s+(.+?)\*\*/;
  const classRe = /^\s*\*\*(REQUIRED BY TEXAS LAW|REQUIRED BY CITY OF AUSTIN|RECOMMENDED BEST PRACTICE|COMMUNITY CHOICE)\*\*/;
  const whyRe = /^\*\*Why it's here:\*\*\s*(.*)$/;
  const whatRe = /^\*\*What you can do:\*\*\s*(.*)$/;
  const impactRe = /^\*\*Community Impact:\*\*\s*(.*)$/;
  const checkboxRe = /☐\s*(Approve|Disapprove|Discuss)/;
  const notesRe = /\*\*Notes:\*\*/;
  const hrRe = /^\s*-{5,}\s*$/;

  function finishSection() {
    if (currentSection && currentArticle) {
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
    if (currentArticle) articles.push(currentArticle);
    currentArticle = null;
  }

  for (const line of lines) {
    const artMatch = line.match(articleRe);
    if (artMatch) {
      finishArticle();
      currentArticle = { articleNumber: romanToInt(artMatch[1]), articleTitle: clean(artMatch[2]), sections: [] };
      continue;
    }
    if (!currentArticle) continue;

    const secMatch = line.match(sectionRe);
    if (secMatch) {
      finishSection();
      currentSection = { sectionNumber: parseSectionNumber(secMatch[1]), sectionTitle: clean(secMatch[2]), classification: 'best_practice', whyItsHere: '', whatYouCanDo: '' };
      collectingField = null;
      continue;
    }
    if (!currentSection) continue;

    const classMatch = line.match(classRe);
    if (classMatch) { currentSection.classification = classifyLabel(classMatch[1]); continue; }
    if (hrRe.test(line) || checkboxRe.test(line) || notesRe.test(line)) continue;
    if (line.match(/^>\s*$/) || line.match(/^>\s*\\_/)) continue;
    if (line.trim() === '') continue;

    const whyMatch = line.match(whyRe);
    if (whyMatch) { collectingField = 'why'; currentSection.whyItsHere = whyMatch[1]; continue; }
    const whatMatch = line.match(whatRe);
    if (whatMatch) { collectingField = 'what'; currentSection.whatYouCanDo = whatMatch[1]; continue; }
    const impactMatch = line.match(impactRe);
    if (impactMatch) { collectingField = 'impact'; currentSection.communityImpact = impactMatch[1]; continue; }

    if (collectingField && !line.startsWith('>') && line.trim()) {
      const trimmed = line.trim();
      if (collectingField === 'why') currentSection.whyItsHere += ' ' + trimmed;
      else if (collectingField === 'what') currentSection.whatYouCanDo += ' ' + trimmed;
      else if (collectingField === 'impact') currentSection.communityImpact += ' ' + trimmed;
    }
  }
  finishArticle();
  return { articles };
}

// ── Governing Document Parser ───────────────────────────────────────────────

function parseGoverningDoc(markdown) {
  const lines = markdown.split('\n');
  const articles = [];
  let currentArticle = null;
  let currentSection = null;
  let textLines = [];

  const articleRe = /^#\s+ARTICLE\s+([IVXLCDM]+)\s*[-–—]\s*(.+)$/i;
  const sectionRe = /^##\s+Section\s+(\S+?)\.?\s+(.+)$/i;

  function finishSection() {
    if (currentSection) {
      currentSection.text = clean(textLines.join('\n').trim());
      if (currentArticle) currentArticle.sections.push(currentSection);
    }
    currentSection = null;
    textLines = [];
  }

  function finishArticle() {
    finishSection();
    if (currentArticle) articles.push(currentArticle);
    currentArticle = null;
  }

  for (const line of lines) {
    const artMatch = line.match(articleRe);
    if (artMatch) {
      finishArticle();
      currentArticle = { articleNumber: romanToInt(artMatch[1]), articleTitle: clean(artMatch[2]), sections: [] };
      textLines = [];
      continue;
    }
    if (!currentArticle) continue;

    const secMatch = line.match(sectionRe);
    if (secMatch) {
      finishSection();
      let title = clean(secMatch[2]).replace(/^[""]|[""]\.?$/g, '').replace(/\.$/, '');
      currentSection = { sectionNumber: parseSectionNumber(secMatch[1]), sectionTitle: title };
      textLines = [];
      continue;
    }

    if (currentSection) {
      if (textLines.length === 0 && line.trim() === '') continue;
      textLines.push(line);
    }
  }
  finishArticle();
  return { articles };
}

// ── Validation ──────────────────────────────────────────────────────────────

function validateAlignment(fieldGuide, govDoc) {
  const errors = [];
  const warnings = [];

  // Build section maps
  const fgSections = new Map();
  const gdSections = new Map();

  for (const art of fieldGuide.articles) {
    for (const sec of art.sections) {
      fgSections.set(sectionKey(art.articleNumber, sec.sectionNumber), {
        articleTitle: art.articleTitle,
        sectionTitle: sec.sectionTitle,
      });
    }
  }

  for (const art of govDoc.articles) {
    for (const sec of art.sections) {
      gdSections.set(sectionKey(art.articleNumber, sec.sectionNumber), {
        articleTitle: art.articleTitle,
        sectionTitle: sec.sectionTitle,
      });
    }
  }

  // Check article count
  if (fieldGuide.articles.length !== govDoc.articles.length) {
    warnings.push(
      'Article count differs: Field Guide has ' + fieldGuide.articles.length +
      ', Governing Doc has ' + govDoc.articles.length
    );
  }

  // Check article numbers match
  const fgArtNums = new Set(fieldGuide.articles.map(a => a.articleNumber));
  const gdArtNums = new Set(govDoc.articles.map(a => a.articleNumber));

  for (const num of fgArtNums) {
    if (!gdArtNums.has(num)) {
      errors.push('Article ' + num + ' exists in Field Guide but NOT in Governing Document');
    }
  }
  for (const num of gdArtNums) {
    if (!fgArtNums.has(num)) {
      warnings.push('Article ' + num + ' exists in Governing Document but NOT in Field Guide');
    }
  }

  // Check sections in Field Guide exist in Governing Doc
  let matchCount = 0;
  for (const [key, fg] of fgSections) {
    if (gdSections.has(key)) {
      matchCount++;
    } else {
      warnings.push('Section ' + key + ' (' + fg.sectionTitle + ') is in Field Guide but NOT in Governing Document — View Text will be unavailable');
    }
  }

  // Check sections in Governing Doc not in Field Guide
  for (const [key, gd] of gdSections) {
    if (!fgSections.has(key)) {
      warnings.push('Section ' + key + ' (' + gd.sectionTitle + ') is in Governing Document but NOT in Field Guide — text will be uploaded but no review card exists');
    }
  }

  return { errors, warnings, matchCount, fgTotal: fgSections.size, gdTotal: gdSections.size };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function main() {
  const argv = process.argv.slice(2);

  // Parse named arguments
  let fieldGuidePath = null;
  let govDocPath = null;
  let outputDir = null;
  let name = null;
  let doUpload = false;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--field-guide' && argv[i+1]) { fieldGuidePath = argv[++i]; continue; }
    if (argv[i] === '--governing-doc' && argv[i+1]) { govDocPath = argv[++i]; continue; }
    if (argv[i] === '--output-dir' && argv[i+1]) { outputDir = argv[++i]; continue; }
    if (argv[i] === '--name' && argv[i+1]) { name = argv[++i]; continue; }
    if (argv[i] === '--upload') { doUpload = true; continue; }
  }

  if (!fieldGuidePath || !govDocPath || !name) {
    console.error('Usage: node parse-review-docs.js \\');
    console.error('  --field-guide "path/to/Field_Guide.docx" \\');
    console.error('  --governing-doc "path/to/CCRs_V1.docx" \\');
    console.error('  --output-dir backend/seeds \\');
    console.error('  --name ccrs-2026-01 \\');
    console.error('  [--upload]');
    console.error('');
    console.error('Parses both documents, validates alignment, and produces two JSON files:');
    console.error('  <name>-seed.json    Field Guide content for reviewer voting');
    console.error('  <name>-text.json    Governing document legal text for View Text popup');
    console.error('');
    console.error('Both files share a documentSetId that the Admin Console validates');
    console.error('to prevent mismatched uploads.');
    process.exit(1);
  }

  outputDir = outputDir || 'backend/seeds';

  // Resolve paths
  fieldGuidePath = path.resolve(fieldGuidePath);
  govDocPath = path.resolve(govDocPath);
  outputDir = path.resolve(outputDir);

  // Validate inputs
  if (!fs.existsSync(fieldGuidePath)) { console.error('Error: Field Guide not found: ' + fieldGuidePath); process.exit(1); }
  if (!fs.existsSync(govDocPath)) { console.error('Error: Governing Document not found: ' + govDocPath); process.exit(1); }
  if (!fieldGuidePath.endsWith('.docx')) { console.error('Error: Field Guide must be a .docx file'); process.exit(1); }
  if (!govDocPath.endsWith('.docx')) { console.error('Error: Governing Document must be a .docx file'); process.exit(1); }

  try { execSync('which pandoc', { stdio: 'pipe' }); } catch {
    console.error('Error: pandoc is not installed. Install with: brew install pandoc');
    process.exit(1);
  }

  // ── Parse Field Guide ──
  console.error('');
  console.error('=== Parsing Field Guide ===');
  console.error('Converting ' + path.basename(fieldGuidePath) + ' to markdown...');
  const fgMarkdown = convertToMarkdown(fieldGuidePath);
  const fieldGuide = parseFieldGuide(fgMarkdown);

  let fgTotal = 0;
  console.error('Articles: ' + fieldGuide.articles.length);
  for (const art of fieldGuide.articles) {
    console.error('  Article ' + String(art.articleNumber).padStart(2) + ' — ' + art.articleTitle + ' (' + art.sections.length + ' sections)');
    fgTotal += art.sections.length;
  }
  console.error('Total sections: ' + fgTotal);

  // ── Parse Governing Document ──
  console.error('');
  console.error('=== Parsing Governing Document ===');
  console.error('Converting ' + path.basename(govDocPath) + ' to markdown...');
  const gdMarkdown = convertToMarkdown(govDocPath);
  const govDoc = parseGoverningDoc(gdMarkdown);

  let gdTotal = 0;
  console.error('Articles: ' + govDoc.articles.length);
  for (const art of govDoc.articles) {
    console.error('  Article ' + String(art.articleNumber).padStart(2) + ' — ' + art.articleTitle + ' (' + art.sections.length + ' sections)');
    gdTotal += art.sections.length;
  }
  console.error('Total sections: ' + gdTotal);

  // ── Validate Alignment ──
  console.error('');
  console.error('=== Validating Alignment ===');
  const validation = validateAlignment(fieldGuide, govDoc);

  console.error('Matched sections: ' + validation.matchCount + ' of ' + validation.fgTotal + ' (Field Guide)');

  if (validation.errors.length > 0) {
    console.error('');
    console.error('ERRORS (must fix before loading):');
    for (const e of validation.errors) {
      console.error('  ✗ ' + e);
    }
  }

  if (validation.warnings.length > 0) {
    console.error('');
    console.error('WARNINGS (review but may be acceptable):');
    for (const w of validation.warnings) {
      console.error('  ⚠ ' + w);
    }
  }

  if (validation.errors.length === 0 && validation.warnings.length === 0) {
    console.error('All sections match perfectly.');
  }

  // Block on errors
  if (validation.errors.length > 0) {
    console.error('');
    console.error('Aborting due to errors. Fix the documents and try again.');
    process.exit(1);
  }

  // ── Generate documentSetId ──
  // Hash based on article/section structure to create a stable, verifiable ID
  const structureString = fieldGuide.articles.map(a =>
    a.articleNumber + ':' + a.sections.map(s => s.sectionNumber).join(',')
  ).join('|');
  const hash = crypto.createHash('sha256').update(structureString).digest('hex').substring(0, 12);
  const documentSetId = name + '-' + hash;

  console.error('');
  console.error('Document Set ID: ' + documentSetId);

  // ── Write output files ──
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const seedOutput = { documentSetId, ...fieldGuide };
  const textOutput = { documentSetId, ...govDoc };

  const seedPath = path.join(outputDir, name + '-seed.json');
  const textPath = path.join(outputDir, name + '-text.json');

  fs.writeFileSync(seedPath, JSON.stringify(seedOutput, null, 2) + '\n');
  fs.writeFileSync(textPath, JSON.stringify(textOutput, null, 2) + '\n');

  console.error('');
  console.error('Output files:');
  console.error('  Seed (Field Guide):     ' + seedPath);
  console.error('  Text (Governing Doc):   ' + textPath);

  // ── Upload to S3 ──
  if (doUpload) {
    const bucket = 'mmpoa-review-seeds';
    console.error('');
    console.error('Uploading to S3...');

    try {
      execSync('aws s3 cp ' + JSON.stringify(seedPath) + ' s3://' + bucket + '/' + path.basename(seedPath) + ' --region us-east-1', { stdio: 'inherit' });
      execSync('aws s3 cp ' + JSON.stringify(textPath) + ' s3://' + bucket + '/' + path.basename(textPath) + ' --region us-east-1', { stdio: 'inherit' });
      console.error('Upload complete.');
    } catch {
      console.error('S3 upload failed. Make sure AWS CLI is configured.');
      process.exit(1);
    }
  }

  console.error('');
  console.error('=== Done ===');
  console.error('');
  console.error('Next steps:');
  console.error('  1. Open the Review Admin Console');
  console.error('  2. Create a cycle (if not already created)');
  console.error('  3. Go to the "Load Review Data" tab');
  console.error('  4. Enter the S3 keys:');
  console.error('       Seed file: ' + path.basename(seedPath));
  console.error('       Text file: ' + path.basename(textPath));
  console.error('  5. Click "Load Review Data" — the system will validate the documentSetId');
}

main();
