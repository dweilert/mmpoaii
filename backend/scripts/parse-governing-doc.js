#!/usr/bin/env node
'use strict';

/**
 * parse-governing-doc.js
 *
 * Extracts the actual legal text from a governing document (.docx) and
 * produces a JSON file that maps each Article/Section to its full text.
 * This JSON is uploaded via the Review Admin Console so reviewers can
 * view the original section text in a popup.
 *
 * Prerequisites:
 *   - pandoc must be installed (brew install pandoc)
 *
 * Usage:
 *   node backend/scripts/parse-governing-doc.js <input.docx> [output.json] [--upload]
 *
 * Examples:
 *   node backend/scripts/parse-governing-doc.js "MMPOA_CCRs_V1.docx" backend/seeds/ccrs-text.json
 *   node backend/scripts/parse-governing-doc.js "MMPOA_CCRs_V1.docx" backend/seeds/ccrs-text.json --upload
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Strip markdown formatting and clean text */
function clean(text) {
  return text
    .replace(/\*\*/g, '')          // bold
    .replace(/\*/g, '')            // italic
    .replace(/\\"/g, '"')          // escaped quotes
    .replace(/\\'/g, "'")          // escaped apostrophes
    .replace(/\\\[/g, '[')         // escaped brackets
    .replace(/\\\]/g, ']')         // escaped brackets
    .trim();
}

/** Parse section number — handles integers and alphanumeric like "19A" */
function parseSectionNumber(str) {
  const trimmed = str.trim().replace(/\.$/, '');
  const asInt = parseInt(trimmed, 10);
  if (String(asInt) === trimmed) return asInt;
  return trimmed;
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

// ── Main parser ──────────────────────────────────────────────────────────────

function parseGoverningDoc(markdown) {
  const lines = markdown.split('\n');
  const articles = [];
  let currentArticle = null;
  let currentSection = null;
  let textLines = [];

  // Regex patterns
  // Article heading: # ARTICLE I - DEFINITIONS  or  # ARTICLE XIV - RATIFICATION AND EXECUTION
  const articleRe = /^#\s+ARTICLE\s+([IVXLCDM]+)\s*[-–—]\s*(.+)$/i;
  // Section heading: ## Section 1. "Association."  or  ## Section 19A. "Wildland-Urban Interface..."
  const sectionRe = /^##\s+Section\s+(\S+?)\.?\s+(.+)$/i;

  function finishSection() {
    if (currentSection) {
      currentSection.text = clean(textLines.join('\n').trim());
      if (currentArticle) {
        currentArticle.sections.push(currentSection);
      }
    }
    currentSection = null;
    textLines = [];
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
      textLines = [];
      continue;
    }

    // Skip lines before first article
    if (!currentArticle) continue;

    // Section heading
    const secMatch = line.match(sectionRe);
    if (secMatch) {
      finishSection();
      // Clean section title — remove surrounding quotes and trailing period
      let title = clean(secMatch[2]).replace(/^[""]|[""]\.?$/g, '').replace(/\.$/, '');
      currentSection = {
        sectionNumber: parseSectionNumber(secMatch[1]),
        sectionTitle: title,
      };
      textLines = [];
      continue;
    }

    // Collect text lines for current section
    if (currentSection) {
      // Skip blank lines at the start
      if (textLines.length === 0 && line.trim() === '') continue;
      textLines.push(line);
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
    console.error('Usage: node parse-governing-doc.js <input.docx> [output.json] [--upload]');
    console.error('');
    console.error('Extracts legal text from a governing document (.docx) into JSON');
    console.error('for the Document Review popup viewer.');
    console.error('');
    console.error('Options:');
    console.error('  --upload    Also upload the JSON to the S3 seed bucket');
    console.error('');
    console.error('Examples:');
    console.error('  node parse-governing-doc.js "CCRs_V1.docx" seeds/ccrs-text.json');
    console.error('  node parse-governing-doc.js "CCRs_V1.docx" seeds/ccrs-text.json --upload');
    process.exit(1);
  }

  const inputPath = path.resolve(args[0]);
  const outputPath = args[1] ? path.resolve(args[1]) : null;

  if (!fs.existsSync(inputPath)) {
    console.error('Error: Input file not found: ' + inputPath);
    process.exit(1);
  }

  if (!inputPath.endsWith('.docx')) {
    console.error('Error: Input must be a .docx file');
    process.exit(1);
  }

  try {
    execSync('which pandoc', { stdio: 'pipe' });
  } catch {
    console.error('Error: pandoc is not installed. Install with: brew install pandoc');
    process.exit(1);
  }

  console.error('Converting ' + path.basename(inputPath) + ' to markdown...');
  const markdown = execSync(
    'pandoc ' + JSON.stringify(inputPath) + ' -t markdown --wrap=none',
    { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
  );

  console.error('Parsing document sections...');
  const result = parseGoverningDoc(markdown);

  // Report
  let totalSections = 0;
  console.error('');
  console.error('Articles found: ' + result.articles.length);
  for (const art of result.articles) {
    console.error('  Article ' + String(art.articleNumber).padStart(2) +
      ' — ' + art.articleTitle + ' (' + art.sections.length + ' sections)');
    totalSections += art.sections.length;
  }
  console.error('');
  console.error('Total sections: ' + totalSections);

  // Show sample
  if (result.articles.length > 0 && result.articles[0].sections.length > 0) {
    const sample = result.articles[0].sections[0];
    console.error('');
    console.error('Sample — Art. 1, §' + sample.sectionNumber + ' — ' + sample.sectionTitle + ':');
    const preview = sample.text.substring(0, 200);
    console.error('  "' + preview + (sample.text.length > 200 ? '..."' : '"'));
  }

  const json = JSON.stringify(result, null, 2);

  if (outputPath) {
    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(outputPath, json + '\n');
    console.error('');
    console.error('Document text JSON written to: ' + outputPath);

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
      } catch {
        console.error('S3 upload failed. Make sure AWS CLI is configured and the bucket exists.');
        process.exit(1);
      }
    }
  } else {
    process.stdout.write(json + '\n');
  }
}

main();
