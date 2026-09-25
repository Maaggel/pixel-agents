#!/usr/bin/env node
// Mark a mailbox message read, correctly.
//
//   node scripts/mailbox-read.mjs <file>...
//
// Three rules this encodes, each of which I have broken or come within one message of breaking:
//
// - **Parse frontmatter as frontmatter** (playbook 17.3). Edit only above the closing `---`. The
//   messages in this channel are *about* this channel, so a body quoting `status: unread` or
//   `read_by:` is ordinary traffic - Plumb's note explaining the mechanism contains the string four
//   times. A whole-file replace rewrites the explanation into a lie; a whole-file *search* reports a
//   field as present that is only being discussed. My own snippet survived that message by the
//   accident of frontmatter coming first in the file.
//
// - **`read_by:` when `to:` names more than one** (17.2). Append `<slug>: <date>` and leave `status`
//   alone; it flips only once every recipient appears there, and the last one to read it flips it.
//   Mix's note to me and Oriel sat showing unread for four days because I did not know this.
//
// - **Read the clock** (17.2, added at 1.25.1). The date comes from the machine, never from what
//   today feels like. I typed four filenames ten minutes into the future and three siblings caught
//   it inside three minutes.
import { readFileSync, writeFileSync } from 'fs'

const ME = 'pixel-agents'
const files = process.argv.slice(2)
if (files.length === 0) {
  console.error('usage: node scripts/mailbox-read.mjs <file>...')
  process.exit(2)
}

const today = new Date().toLocaleDateString('sv-SE') // YYYY-MM-DD, local

/** Split a message into its frontmatter lines and everything after, or null if it has none. */
function split(text) {
  const lines = text.split('\n')
  if (lines[0].trim() !== '---') return null
  const close = lines.indexOf('---', 1)
  if (close === -1) return null
  return { head: lines.slice(1, close), rest: lines.slice(close + 1) }
}

const field = (head, name) => head.findIndex((l) => l.startsWith(`${name}:`))

for (const file of files) {
  const text = readFileSync(file, 'utf-8')
  const parts = split(text)
  if (!parts) {
    console.log(`${file}: no frontmatter, not a message`)
    continue
  }
  const { head, rest } = parts

  const statusAt = field(head, 'status')
  if (statusAt === -1 || !/^status:\s*unread\s*$/.test(head[statusAt])) {
    console.log(`${file}: already read`)
    continue
  }

  const toAt = field(head, 'to')
  const recipients = toAt === -1 ? [] : head[toAt].slice(3).split(',').map((s) => s.trim()).filter(Boolean)

  if (recipients.length > 1) {
    // Per-recipient read state: record myself, and flip status only if I am the last
    let readByAt = field(head, 'read_by')
    if (readByAt === -1) {
      head.push('read_by:')
      readByAt = head.length - 1
    }
    let end = readByAt + 1
    while (end < head.length && /^\s+\S/.test(head[end])) end++
    const entries = head.slice(readByAt + 1, end)
    if (!entries.some((l) => l.trim().startsWith(`${ME}:`))) {
      entries.push(`  ${ME}: ${today}`)
    }
    head.splice(readByAt + 1, end - readByAt - 1, ...entries)

    const slugs = entries.map((l) => l.trim().split(':')[0])
    const everyone = recipients.every((r) => {
      const m = r.match(/\(([^)]+)\)\s*$/)
      const slug = (m ? m[1] : r).toLowerCase().replace(/\s+/g, '-')
      return slugs.some((s) => slug.includes(s) || s.includes(slug.split('-')[0]))
    })
    if (everyone) head[statusAt] = 'status: read'
    console.log(`${file}: recorded ${ME}${everyone ? ', and flipped status' : ' (waiting on the others)'}`)
  } else {
    head[statusAt] = 'status: read'
    const readAt = field(head, 'read')
    if (readAt === -1) head.splice(statusAt + 1, 0, `read: ${today}`)
    else head[readAt] = `read: ${today}`
    console.log(`${file}: read ${today}`)
  }

  writeFileSync(file, ['---', ...head, '---', ...rest].join('\n'))
}
