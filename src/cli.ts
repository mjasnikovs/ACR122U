#!/usr/bin/env bun
import {ACR122U} from './reader.ts'
import {MIFARE_BLOCK_SIZE, MIFARE_1K_SECTORS} from './types.ts'

const HELP = `
acr122u - NFC reader CLI

Usage: bun src/cli.ts <command> [options]

Commands:
  info                       Show reader & card info
  read [--sector N] [--json] Full tag dump (or single sector)
  write <block> <hex>        Write 16 bytes (hex) to a block
  watch                      Continuously scan for cards
  led <red|green|both|off>   Set LED state
  led blink [--count N]      Blink both LEDs
  beep                       Short buzzer beep
  uid                        Print card UID only
  raw <hex>                  Send raw APDU (hex)
`.trim()

function hex(buf: Buffer): string {
    return Array.from(buf)
        .map(b => b.toString(16).padStart(2, '0'))
        .join(' ')
}

function ascii(buf: Buffer): string {
    return Array.from(buf)
        .map(b => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.'))
        .join('')
}

function parseHex(s: string): Buffer {
    const clean = s.replace(/[\s:-]/g, '')
    if (!/^[0-9a-fA-F]*$/.test(clean) || clean.length % 2 !== 0) {
        throw new Error(`Invalid hex string: ${s}`)
    }
    return Buffer.from(clean, 'hex')
}

function flag(name: string): boolean {
    return process.argv.includes(name)
}

function arg(name: string): string | undefined {
    const idx = process.argv.indexOf(name)
    if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1]
    return undefined
}

const command = process.argv[2]

if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(HELP)
    process.exit(0)
}

const reader = new ACR122U()

function connect(): void {
    try {
        reader.open()
    } catch (e) {
        console.error('Failed to connect:', (e as Error).message)
        process.exit(1)
    }
}

function ensureCard(): void {
    if (!reader.isCardPresent()) {
        console.error('No card on reader.')
        process.exit(1)
    }
}

try {
    switch (command) {
        case 'info': {
            connect()
            console.log(`Firmware:  ${reader.firmware()}`)
            console.log(`Card:      ${reader.isCardPresent() ? 'present' : 'not present'}`)
            if (reader.isCardPresent()) {
                const card = reader.detectCard()
                if (card) {
                    console.log(`UID:       ${card.uidHex}`)
                    console.log(`Type:      ${card.type}`)
                    console.log(`ATR:       ${card.atr.toString('hex')}`)
                }
            }
            break
        }

        case 'uid': {
            connect()
            ensureCard()
            console.log(reader.getUid().toString('hex').toUpperCase())
            break
        }

        case 'read': {
            connect()
            ensureCard()
            const sectorArg = arg('--sector')
            const jsonMode = flag('--json')
            const sectors = sectorArg ? [parseInt(sectorArg, 10)] : undefined

            if (
                sectorArg !== undefined
                && (isNaN(sectors![0]!) || sectors![0]! < 0 || sectors![0]! >= MIFARE_1K_SECTORS)
            ) {
                console.error(`Invalid sector: ${sectorArg} (0-15)`)
                process.exit(1)
            }

            const result = reader.fullRead(sectors ? {sectors} : {})

            if (jsonMode) {
                const out = {
                    uid: result.uidHex,
                    blocks: result.blocks.map(b => ({
                        sector: b.sector,
                        block: b.block,
                        abs: b.absoluteBlock,
                        hex: b.data.toString('hex')
                    }))
                }
                console.log(JSON.stringify(out, null, 2))
            } else {
                console.log(`UID: ${result.uidHex}`)
                console.log(`Blocks: ${result.blocks.length}  Bytes: ${result.raw.length}\n`)

                let lastSector = -1
                for (const block of result.blocks) {
                    if (block.sector !== lastSector) {
                        if (lastSector >= 0) console.log()
                        console.log(`── Sector ${block.sector} ──`)
                        lastSector = block.sector
                    }
                    const isTrailer = block.block === 3
                    const tag =
                        isTrailer ? ' [trailer]'
                        : block.absoluteBlock === 0 ? ' [mfr]'
                        : ''
                    console.log(
                        `  ${String(block.absoluteBlock).padStart(2, ' ')} | ${hex(block.data)} | ${ascii(block.data)}${tag}`
                    )
                }
            }
            break
        }

        case 'write': {
            connect()
            ensureCard()
            const blockStr = process.argv[3]
            const hexStr = process.argv[4]

            if (!blockStr || !hexStr) {
                console.error('Usage: write <block> <hex>')
                console.error('  block: 0-63 (block 0 and trailer blocks are protected)')
                console.error('  hex:   32 hex chars (16 bytes)')
                process.exit(1)
            }

            const blockNum = parseInt(blockStr, 10)
            if (isNaN(blockNum) || blockNum < 0 || blockNum > 63) {
                console.error(`Invalid block number: ${blockStr}`)
                process.exit(1)
            }

            const data = parseHex(hexStr)
            if (data.length !== MIFARE_BLOCK_SIZE) {
                console.error(`Data must be exactly 16 bytes (32 hex chars), got ${data.length}`)
                process.exit(1)
            }

            // Read before write for confirmation
            const sector =
                blockNum < 128 ? Math.floor(blockNum / 4) : 32 + Math.floor((blockNum - 128) / 16)
            reader.authenticateSector(sector)
            const before = reader.readBlock(blockNum)
            console.log(`Block ${blockNum} before: ${hex(before)}`)
            console.log(`Writing:          ${hex(data)}`)

            reader.writeBlock(blockNum, data)

            // Verify
            reader.authenticateSector(sector)
            const after = reader.readBlock(blockNum)
            const ok = after.equals(data)
            console.log(`Block ${blockNum} after:  ${hex(after)}`)
            console.log(ok ? 'Verified OK' : 'VERIFY FAILED!')
            if (!ok) process.exit(1)
            break
        }

        case 'watch': {
            connect()
            console.log('Watching for cards... (Ctrl+C to stop)\n')

            let lastUid = ''
            reader.on('card', card => {
                const ts = new Date().toISOString().slice(11, 19)
                if (card.uidHex !== lastUid) {
                    console.log(`[${ts}] Card detected: ${card.uidHex} (${card.type})`)
                    lastUid = card.uidHex
                }
            })
            reader.on('card:removed', () => {
                const ts = new Date().toISOString().slice(11, 19)
                console.log(`[${ts}] Card removed`)
                lastUid = ''
            })
            reader.on('error', err => {
                console.error(`Error: ${err.message}`)
            })
            reader.on('disconnect', () => {
                console.log('Reader disconnected, attempting reconnect...')
            })

            reader.enableReconnect()
            reader.listen(300)

            // Keep alive
            process.on('SIGINT', () => {
                console.log('\nStopping...')
                reader.close()
                process.exit(0)
            })
            // Block forever
            await new Promise(() => {})
            break
        }

        case 'led': {
            connect()
            const mode = process.argv[3]
            if (!mode) {
                console.error('Usage: led <red|green|both|off|blink>')
                process.exit(1)
            }
            switch (mode) {
                case 'red':
                    reader.led({red: true, green: false})
                    break
                case 'green':
                    reader.led({red: false, green: true})
                    break
                case 'both':
                    reader.led({red: true, green: true})
                    break
                case 'off':
                    reader.led({red: false, green: false})
                    break
                case 'blink': {
                    const count = parseInt(arg('--count') ?? '5', 10)
                    reader.led({
                        blink: {
                            red: true,
                            green: true,
                            t1Duration: 300,
                            t2Duration: 300,
                            repeat: count,
                            buzzerOnT1: true
                        }
                    })
                    break
                }
                default:
                    console.error(`Unknown LED mode: ${mode}`)
                    process.exit(1)
            }
            console.log(`LED: ${mode}`)
            break
        }

        case 'beep': {
            connect()
            reader.led({
                blink: {
                    red: true,
                    t1Duration: 100,
                    t2Duration: 100,
                    repeat: 1,
                    buzzerOnT1: true
                }
            })
            console.log('Beep!')
            break
        }

        case 'raw': {
            connect()
            const apduHex = process.argv[3]
            if (!apduHex) {
                console.error('Usage: raw <hex>')
                console.error('  Example: raw FF00480000  (get firmware)')
                process.exit(1)
            }
            const apdu = parseHex(apduHex)
            console.log(`>> ${hex(apdu)}`)
            const resp = reader.transmit(apdu)
            console.log(
                `<< ${hex(resp.data)} SW=${resp.sw1.toString(16).padStart(2, '0')}${resp.sw2.toString(16).padStart(2, '0')}`
            )
            console.log(`   ${resp.success ? 'OK' : 'FAIL'}`)
            break
        }

        default:
            console.error(`Unknown command: ${command}`)
            console.log(HELP)
            process.exit(1)
    }
} catch (e) {
    console.error(`Error: ${(e as Error).message}`)
    process.exit(1)
} finally {
    if (command !== 'watch') reader.close()
}
