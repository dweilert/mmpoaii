'use strict';

/**
 * One-time cleanup script:
 * 1. Remove the legacy 'notes' attribute from all VOTE# records
 * 2. Deduplicate comments — remove partial-message duplicates left by old autosave
 *
 * Usage: node cleanup-notes.js [--dry-run]
 */

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, ScanCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');

const TABLE_NAME = process.env.TABLE_NAME || 'mmpoa-reviews';
const REGION = process.env.AWS_REGION || 'us-east-1';
const DRY_RUN = process.argv.includes('--dry-run');

const client = new DynamoDBClient({ region: REGION });
const ddb = DynamoDBDocumentClient.from(client);

/**
 * Deduplicate comments by removing entries where the text is a substring
 * of a later (or same-time) comment from the same typing session.
 * Keeps only the longest/final version of each message.
 */
function deduplicateComments(comments) {
  if (!comments || comments.length === 0) return [];

  // Sort by timestamp ascending so we process in order
  const sorted = [...comments].sort((a, b) => {
    if (!a.at) return -1;
    if (!b.at) return 1;
    return a.at.localeCompare(b.at);
  });

  const keep = [];
  for (let i = 0; i < sorted.length; i++) {
    const current = sorted[i];
    const currentText = (current.text || '').trim();
    if (!currentText) continue; // skip empty

    // Check if any later comment contains this text (partial typing)
    let isPartial = false;
    for (let j = i + 1; j < sorted.length; j++) {
      const later = (sorted[j].text || '').trim();
      if (later && later.includes(currentText)) {
        isPartial = true;
        break;
      }
    }

    if (!isPartial) {
      // Check if this exact text already exists in keep list
      const alreadyKept = keep.some(k => k.text === currentText);
      if (!alreadyKept) {
        keep.push(current);
      }
    }
  }

  return keep;
}

async function main() {
  console.log(DRY_RUN ? '=== DRY RUN ===' : '=== LIVE RUN ===');
  console.log('Table:', TABLE_NAME);
  console.log('');

  let notesRemoved = 0;
  let commentsCleaned = 0;
  let totalScanned = 0;
  let lastKey = undefined;

  do {
    const scanParams = {
      TableName: TABLE_NAME,
      FilterExpression: 'begins_with(SK, :vote) AND (attribute_exists(notes) OR attribute_exists(comments))',
      ExpressionAttributeValues: { ':vote': 'VOTE#' },
    };
    if (lastKey) scanParams.ExclusiveStartKey = lastKey;

    const result = await ddb.send(new ScanCommand(scanParams));
    lastKey = result.LastEvaluatedKey;

    for (const item of (result.Items || [])) {
      totalScanned++;
      const pk = item.PK;
      const sk = item.SK;
      const hasNotes = item.notes !== undefined;
      const hasComments = item.comments && item.comments.length > 0;

      const updates = [];
      const removeAttrs = [];
      const names = {};
      const values = {};

      // 1. Remove notes field
      if (hasNotes) {
        removeAttrs.push('#notes');
        names['#notes'] = 'notes';
        notesRemoved++;
      }

      // 2. Deduplicate comments
      if (hasComments) {
        const cleaned = deduplicateComments(item.comments);
        const removed = item.comments.length - cleaned.length;
        if (removed > 0) {
          updates.push('#comments = :cleanedComments');
          names['#comments'] = 'comments';
          values[':cleanedComments'] = cleaned;
          commentsCleaned++;
          console.log(`  ${sk}: ${item.comments.length} comments -> ${cleaned.length} (removed ${removed} duplicates)`);
        }
      }

      // Build and execute update if needed
      if (updates.length === 0 && removeAttrs.length === 0) continue;

      let expression = '';
      if (updates.length > 0) expression += 'SET ' + updates.join(', ');
      if (removeAttrs.length > 0) {
        if (expression) expression += ' ';
        expression += 'REMOVE ' + removeAttrs.join(', ');
      }

      if (DRY_RUN) {
        console.log(`  [dry-run] Would update ${sk}:`, expression);
      } else {
        await ddb.send(new UpdateCommand({
          TableName: TABLE_NAME,
          Key: { PK: pk, SK: sk },
          UpdateExpression: expression,
          ExpressionAttributeNames: Object.keys(names).length > 0 ? names : undefined,
          ExpressionAttributeValues: Object.keys(values).length > 0 ? values : undefined,
        }));
      }
    }
  } while (lastKey);

  console.log('');
  console.log('Summary:');
  console.log(`  Records scanned: ${totalScanned}`);
  console.log(`  Notes fields removed: ${notesRemoved}`);
  console.log(`  Records with comments deduplicated: ${commentsCleaned}`);
  console.log(DRY_RUN ? '\nRe-run without --dry-run to apply changes.' : '\nDone!');
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
