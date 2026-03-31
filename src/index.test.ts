import {test, expect, describe, beforeAll, afterAll, beforeEach} from 'bun:test'
import {ACR122U} from './reader.ts'
import {UsbDevice} from './usb.ts'
import {CcidTransport} from './ccid.ts'
import * as cmd from './commands.ts'
import {
    VENDOR_ID,
    PRODUCT_ID,
    MIFARE_DEFAULT_KEY,
    MIFARE_BLOCK_SIZE,
    MIFARE_1K_BLOCKS,
    MIFARE_1K_SECTORS,
    EP_BULK_IN,
    EP_BULK_OUT,
    EP_INTERRUPT_IN,
    CCID_HEADER_SIZE,
    PC_TO_RDR_ICCPOWERON,
    PC_TO_RDR_XFRBLOCK,
    RDR_TO_PC_DATABLOCK,
    RDR_TO_PC_SLOTSTATUS,
    LED_RED,
    LED_GREEN
} from './types.ts'

// ─── USB Layer Tests ───

describe('UsbDevice', () => {
    test('findDevice returns path for connected ACR122U', () => {
        const path = UsbDevice.findDevice()
        expect(path).not.toBeNull()
        expect(path).toMatch(/\/dev\/bus\/usb\/\d{3}\/\d{3}/)
    })

    test('open and close device', () => {
        const usb = new UsbDevice()
        usb.open()
        expect(usb.isOpen).toBe(true)
        expect(usb.path).toMatch(/\/dev\/bus\/usb\//)
        usb.close()
        expect(usb.isOpen).toBe(false)
    })

    test('open throws for nonexistent device', () => {
        const usb = new UsbDevice()
        expect(() => usb.open('/dev/bus/usb/099/099')).toThrow()
    })

    test('detach kernel driver, claim, release', () => {
        const usb = new UsbDevice()
        usb.open()
        usb.resetDevice()
        usb.close()
        usb.open()
        usb.detachKernelDriver() // should not throw even if no driver
        usb.claimInterface()
        usb.releaseInterface()
        usb.close()
    })

    test('flush drains pending data', () => {
        const usb = new UsbDevice()
        usb.open()
        usb.resetDevice()
        usb.close()
        usb.open()
        usb.detachKernelDriver()
        usb.claimInterface()
        // flush should not throw even if no data
        usb.flush(EP_BULK_IN)
        usb.close()
    })
})

// ─── CCID Layer Tests ───

describe('CcidTransport', () => {
    let usb: UsbDevice
    let ccid: CcidTransport

    beforeAll(() => {
        usb = new UsbDevice()
        usb.open()
        usb.resetDevice()
        usb.close()
        usb.open()
        usb.detachKernelDriver()
        usb.claimInterface()
        ccid = new CcidTransport(usb)
    })

    afterAll(() => {
        try {
            ccid.powerOff()
        } catch {
            /* cleanup */
        }
        usb.close()
    })

    test('powerOn returns DataBlock with ATR', () => {
        const resp = ccid.powerOn()
        expect(resp.messageType).toBe(RDR_TO_PC_DATABLOCK)
        expect(resp.cmdStatus).toBe(0)
        expect(resp.data.length).toBeGreaterThan(0)
        // ATR should start with 0x3B (TS byte)
        expect(resp.data[0]).toBe(0x3b)
    })

    test('getSlotStatus returns SlotStatus', () => {
        const resp = ccid.getSlotStatus()
        expect(resp.messageType).toBe(RDR_TO_PC_SLOTSTATUS)
        expect(resp.cmdStatus).toBe(0)
    })

    test('isCardPresent returns true (card on reader)', () => {
        expect(ccid.isCardPresent()).toBe(true)
    })

    test('transmit firmware APDU returns ASCII string', () => {
        const resp = ccid.transmit(cmd.getFirmwareVersion())
        expect(resp.messageType).toBe(RDR_TO_PC_DATABLOCK)
        const fw = resp.data.toString('ascii')
        expect(fw).toContain('ACR122U')
    })

    test('transmit UID APDU returns card UID', () => {
        const resp = ccid.transmit(cmd.getUid())
        const sw = cmd.checkSW(resp.data)
        expect(sw.success).toBe(true)
        expect(sw.data.length).toBeGreaterThanOrEqual(4)
    })

    test('powerOff and powerOn cycle', () => {
        const off = ccid.powerOff()
        expect(off.cmdStatus).toBe(0)

        const on = ccid.powerOn()
        expect(on.messageType).toBe(RDR_TO_PC_DATABLOCK)
        expect(on.data.length).toBeGreaterThan(0)
    })
})

// ─── Command Builder Tests ───

describe('APDU Commands', () => {
    test('getFirmwareVersion builds correct APDU', () => {
        const apdu = cmd.getFirmwareVersion()
        expect(apdu).toEqual(Buffer.from([0xff, 0x00, 0x48, 0x00, 0x00]))
    })

    test('getUid builds correct APDU', () => {
        const apdu = cmd.getUid()
        expect(apdu).toEqual(Buffer.from([0xff, 0xca, 0x00, 0x00, 0x00]))
    })

    test('loadKey builds correct APDU with default key', () => {
        const apdu = cmd.loadKey(0)
        expect(apdu).toEqual(
            Buffer.from([0xff, 0x82, 0x00, 0x00, 0x06, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])
        )
    })

    test('loadKey builds correct APDU with custom key', () => {
        const key = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x06])
        const apdu = cmd.loadKey(1, key)
        expect(apdu).toEqual(
            Buffer.from([0xff, 0x82, 0x00, 0x01, 0x06, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06])
        )
    })

    test('authenticate builds correct APDU', () => {
        const apdu = cmd.authenticate(4, 'A', 0)
        expect(apdu).toEqual(
            Buffer.from([0xff, 0x86, 0x00, 0x00, 0x05, 0x01, 0x00, 0x04, 0x60, 0x00])
        )
    })

    test('authenticate with key B', () => {
        const apdu = cmd.authenticate(8, 'B', 1)
        expect(apdu).toEqual(
            Buffer.from([0xff, 0x86, 0x00, 0x00, 0x05, 0x01, 0x00, 0x08, 0x61, 0x01])
        )
    })

    test('readBlock builds correct APDU', () => {
        const apdu = cmd.readBlock(5)
        expect(apdu).toEqual(Buffer.from([0xff, 0xb0, 0x00, 0x05, 0x10]))
    })

    test('writeBlock builds correct APDU', () => {
        const data = Buffer.alloc(16, 0xaa)
        const apdu = cmd.writeBlock(5, data)
        expect(apdu.length).toBe(5 + 16)
        expect(apdu[0]).toBe(0xff)
        expect(apdu[1]).toBe(0xd6)
        expect(apdu[3]).toBe(0x05)
        expect(apdu[4]).toBe(0x10)
    })

    test('writeBlock rejects non-16-byte data', () => {
        expect(() => cmd.writeBlock(5, Buffer.alloc(8))).toThrow('exactly 16 bytes')
    })

    test('ledControl builds correct APDU', () => {
        const apdu = cmd.ledControl(0x11, 5, 5, 3, 0x01)
        expect(apdu).toEqual(Buffer.from([0xff, 0x00, 0x40, 0x11, 0x04, 0x05, 0x05, 0x03, 0x01]))
    })

    test('buzzerControl builds correct APDU', () => {
        const apdu = cmd.buzzerControl(0xff)
        expect(apdu).toEqual(Buffer.from([0xff, 0x00, 0x52, 0xff, 0x00]))
    })

    test('checkSW parses success response', () => {
        const data = Buffer.from([0xbe, 0x6a, 0xa4, 0x03, 0x90, 0x00])
        const result = cmd.checkSW(data)
        expect(result.success).toBe(true)
        expect(result.sw1).toBe(0x90)
        expect(result.sw2).toBe(0x00)
        expect(result.data).toEqual(Buffer.from([0xbe, 0x6a, 0xa4, 0x03]))
    })

    test('checkSW parses error response', () => {
        const data = Buffer.from([0x63, 0x00])
        const result = cmd.checkSW(data)
        expect(result.success).toBe(false)
        expect(result.sw1).toBe(0x63)
    })

    test('checkSW handles short response', () => {
        const result = cmd.checkSW(Buffer.from([0x90]))
        expect(result.success).toBe(false)
    })
})

// ─── Reader High-Level Tests ───

describe('ACR122U Reader', () => {
    let reader: ACR122U

    beforeAll(() => {
        reader = new ACR122U()
        reader.open()
    })

    afterAll(() => {
        reader.close()
    })

    test('connected after open', () => {
        expect(reader.connected).toBe(true)
    })

    test('firmware returns version string', () => {
        const fw = reader.firmware()
        expect(fw).toContain('ACR122U')
        expect(fw.length).toBeGreaterThan(5)
    })

    test('isCardPresent returns true', () => {
        expect(reader.isCardPresent()).toBe(true)
    })

    test('detectCard returns card info', () => {
        const card = reader.detectCard()
        expect(card).not.toBeNull()
        expect(card!.uid.length).toBeGreaterThanOrEqual(4)
        expect(card!.uidHex).toMatch(/^[0-9A-F]+$/)
        expect(card!.type).toBe('mifare-1k')
        expect(card!.atr.length).toBeGreaterThan(0)
    })

    test('getUid returns 4-byte UID', () => {
        const uid = reader.getUid()
        expect(uid.length).toBe(4)
    })

    test('powerOnCard returns ATR', () => {
        const resp = reader.powerOnCard()
        expect(resp.data.length).toBeGreaterThan(0)
        expect(resp.data[0]).toBe(0x3b)
    })

    test('transmit raw APDU works', () => {
        const resp = reader.transmit(cmd.getFirmwareVersion())
        expect(resp.data.toString('ascii')).toContain('ACR122U')
    })
})

// ─── LED Tests ───

describe('LED Control', () => {
    let reader: ACR122U

    beforeAll(() => {
        reader = new ACR122U()
        reader.open()
    })

    afterAll(() => {
        reader.led({red: false, green: false})
        reader.close()
    })

    test('red LED on', () => {
        expect(() => reader.led({red: true, green: false})).not.toThrow()
    })

    test('green LED on', () => {
        expect(() => reader.led({red: false, green: true})).not.toThrow()
    })

    test('both LEDs on', () => {
        expect(() => reader.led({red: true, green: true})).not.toThrow()
    })

    test('both LEDs off', () => {
        expect(() => reader.led({red: false, green: false})).not.toThrow()
    })

    test('LED blink', () => {
        expect(() =>
            reader.led({
                blink: {
                    red: true,
                    green: true,
                    t1Duration: 200,
                    t2Duration: 200,
                    repeat: 2
                }
            })
        ).not.toThrow()
    })

    test('LED blink with buzzer', () => {
        expect(() =>
            reader.led({
                blink: {
                    red: true,
                    t1Duration: 100,
                    t2Duration: 100,
                    repeat: 1,
                    buzzerOnT1: true
                }
            })
        ).not.toThrow()
    })

    test('buzzer on/off', () => {
        expect(() => reader.buzzer(false)).not.toThrow()
    })
})

// ─── MIFARE Read Tests ───

describe('MIFARE Read', () => {
    let reader: ACR122U

    beforeAll(() => {
        reader = new ACR122U()
        reader.open()
    })

    afterAll(() => {
        reader.close()
    })

    test('authenticate sector 0 with default key', () => {
        expect(() => reader.authenticateSector(0)).not.toThrow()
    })

    test('read block 0 (manufacturer block)', () => {
        reader.authenticateSector(0)
        const data = reader.readBlock(0)
        expect(data.length).toBe(MIFARE_BLOCK_SIZE)
        // First 4 bytes should be UID
        const uid = reader.getUid()
        reader.authenticateSector(0)
        const block0 = reader.readBlock(0)
        expect(block0.subarray(0, 4)).toEqual(uid)
    })

    test('read block returns exactly 16 bytes', () => {
        reader.authenticateSector(0)
        const data = reader.readBlock(1)
        expect(data.length).toBe(16)
    })

    test('read sector trailer block', () => {
        reader.authenticateSector(0)
        const trailer = reader.readBlock(3)
        expect(trailer.length).toBe(16)
        // Access bits are at bytes 6-8
        expect(trailer[6]).toBeDefined()
    })

    test('authenticate and read sector 1', () => {
        reader.authenticateSector(1)
        const data = reader.readBlock(4)
        expect(data.length).toBe(16)
    })

    test('full read returns all 64 blocks (1024 bytes)', () => {
        const result = reader.fullRead()
        expect(result.blocks.length).toBe(MIFARE_1K_BLOCKS)
        expect(result.raw.length).toBe(MIFARE_1K_BLOCKS * MIFARE_BLOCK_SIZE)
        expect(result.uid.length).toBeGreaterThanOrEqual(4)
        expect(result.uidHex).toMatch(/^[0-9A-F]+$/)
    })

    test('full read - every block is exactly 16 bytes', () => {
        const result = reader.fullRead()
        for (const block of result.blocks) {
            expect(block.data.length).toBe(MIFARE_BLOCK_SIZE)
        }
    })

    test('full read - blocks have correct sector/block mapping', () => {
        const result = reader.fullRead()
        // Sector 0, block 0
        expect(result.blocks[0]!.sector).toBe(0)
        expect(result.blocks[0]!.block).toBe(0)
        expect(result.blocks[0]!.absoluteBlock).toBe(0)
        // Sector 1, block 0
        expect(result.blocks[4]!.sector).toBe(1)
        expect(result.blocks[4]!.block).toBe(0)
        expect(result.blocks[4]!.absoluteBlock).toBe(4)
        // Sector 15, block 3
        expect(result.blocks[63]!.sector).toBe(15)
        expect(result.blocks[63]!.block).toBe(3)
        expect(result.blocks[63]!.absoluteBlock).toBe(63)
    })

    test('full read specific sectors only', () => {
        const result = reader.fullRead({sectors: [0, 1]})
        expect(result.blocks.length).toBe(8) // 2 sectors × 4 blocks
        expect(result.raw.length).toBe(128) // 8 × 16
    })

    test('full read with explicit default key', () => {
        const result = reader.fullRead({key: MIFARE_DEFAULT_KEY, keyType: 'A'})
        expect(result.blocks.length).toBe(MIFARE_1K_BLOCKS)
    })

    test('full read raw data concatenation is correct', () => {
        const result = reader.fullRead({sectors: [0]})
        const manualConcat = Buffer.concat(result.blocks.map(b => b.data))
        expect(result.raw).toEqual(manualConcat)
    })
})

// ─── MIFARE Write Tests ───

describe('MIFARE Write', () => {
    let reader: ACR122U
    let originalBlock4: Buffer

    beforeAll(() => {
        reader = new ACR122U()
        reader.open()
        // Save original data
        reader.authenticateSector(1)
        originalBlock4 = Buffer.from(reader.readBlock(4))
    })

    afterAll(() => {
        // Restore original data
        try {
            reader.authenticateSector(1)
            reader.writeBlock(4, originalBlock4)
        } catch {
            /* cleanup */
        }
        reader.close()
    })

    test('write and read back block 4', () => {
        const testData = Buffer.alloc(16)
        testData.write('TEST-WRITE-1234!', 'ascii')

        reader.authenticateSector(1)
        reader.writeBlock(4, testData)

        reader.authenticateSector(1)
        const readBack = reader.readBlock(4)
        expect(readBack).toEqual(testData)
    })

    test('write binary data', () => {
        const testData = Buffer.from([
            0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d,
            0x0e, 0x0f
        ])

        reader.authenticateSector(1)
        reader.writeBlock(4, testData)

        reader.authenticateSector(1)
        const readBack = reader.readBlock(4)
        expect(readBack).toEqual(testData)
    })

    test('write all-zeros', () => {
        const zeros = Buffer.alloc(16, 0x00)
        reader.authenticateSector(1)
        reader.writeBlock(4, zeros)

        reader.authenticateSector(1)
        const readBack = reader.readBlock(4)
        expect(readBack).toEqual(zeros)
    })

    test('write all-0xFF', () => {
        const full = Buffer.alloc(16, 0xff)
        reader.authenticateSector(1)
        reader.writeBlock(4, full)

        reader.authenticateSector(1)
        const readBack = reader.readBlock(4)
        expect(readBack).toEqual(full)
    })

    test('write block 0 throws (manufacturer block)', () => {
        expect(() => reader.writeBlock(0, Buffer.alloc(16))).toThrow('manufacturer block')
    })

    test('fullWrite writes multiple blocks', () => {
        const data = Buffer.alloc(32) // 2 blocks
        data.write('BLOCK-4-DATA!!!!', 0, 'ascii')
        data.write('BLOCK-5-DATA!!!!', 16, 'ascii')

        reader.fullWrite(4, data)

        // Verify
        reader.authenticateSector(1)
        const b4 = reader.readBlock(4)
        const b5 = reader.readBlock(5)
        expect(b4.toString('ascii')).toBe('BLOCK-4-DATA!!!!')
        expect(b5.toString('ascii')).toBe('BLOCK-5-DATA!!!!')
    })

    test('fullWrite rejects non-16-byte-aligned data', () => {
        expect(() => reader.fullWrite(4, Buffer.alloc(10))).toThrow('multiple of 16')
    })
})

// ─── Event System Tests ───

describe('Events', () => {
    test('emits connect event on open', () => {
        const reader = new ACR122U()
        let connected = false
        reader.on('connect', () => {
            connected = true
        })
        reader.open()
        expect(connected).toBe(true)
        reader.close()
    })

    test('cardPresent reflects current state', () => {
        const reader = new ACR122U()
        expect(reader.cardPresent).toBe(false)
        reader.open()
        // Card is on reader but we haven't polled yet
        expect(reader.cardPresent).toBe(false)
        reader.close()
    })

    test('connected reflects state', () => {
        const reader = new ACR122U()
        expect(reader.connected).toBe(false)
        reader.open()
        expect(reader.connected).toBe(true)
        reader.close()
        expect(reader.connected).toBe(false)
    })
})

// ─── Error Handling Tests ───

describe('Error Handling', () => {
    test('operations throw when not connected', () => {
        const reader = new ACR122U()
        expect(() => reader.firmware()).toThrow('not connected')
        expect(() => reader.getUid()).toThrow('not connected')
        expect(() => reader.isCardPresent()).toThrow('not connected')
        expect(() => reader.readBlock(0)).toThrow('not connected')
        expect(() => reader.writeBlock(1, Buffer.alloc(16))).toThrow('not connected')
        expect(() => reader.led({red: true})).toThrow('not connected')
        expect(() => reader.fullRead()).toThrow('not connected')
    })

    test('close is idempotent', () => {
        const reader = new ACR122U()
        reader.open()
        reader.close()
        expect(() => reader.close()).not.toThrow()
    })

    test('authentication with wrong key fails', () => {
        const reader = new ACR122U()
        reader.open()
        try {
            const wrongKey = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00, 0x00])
            // Sector 0 with default key should work, but wrong key should fail
            // Note: this depends on the card's key configuration
            expect(() => reader.authenticateSector(0, 'A', wrongKey)).toThrow()
        } finally {
            reader.close()
        }
    })

    test('read without authentication fails', () => {
        const reader = new ACR122U()
        reader.open()
        try {
            // After opening (fresh state), trying to read without auth should fail
            // because the power cycle resets authentication
            expect(() => reader.readBlock(4)).toThrow()
        } finally {
            reader.close()
        }
    })
})

// ─── Constants Tests ───

describe('Constants', () => {
    test('VENDOR_ID is correct', () => {
        expect(VENDOR_ID).toBe(0x072f)
    })

    test('PRODUCT_ID is correct', () => {
        expect(PRODUCT_ID).toBe(0x2200)
    })

    test('MIFARE constants', () => {
        expect(MIFARE_BLOCK_SIZE).toBe(16)
        expect(MIFARE_1K_BLOCKS).toBe(64)
        expect(MIFARE_1K_SECTORS).toBe(16)
        expect(MIFARE_DEFAULT_KEY).toEqual(Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]))
    })

    test('endpoint addresses', () => {
        expect(EP_BULK_OUT).toBe(0x02)
        expect(EP_BULK_IN).toBe(0x82)
        expect(EP_INTERRUPT_IN).toBe(0x81)
    })
})
