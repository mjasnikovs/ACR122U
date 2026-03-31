import {EventEmitter} from 'node:events'
import {UsbDevice} from './usb.ts'
import {CcidTransport} from './ccid.ts'
import type {CcidResponse} from './ccid.ts'
import * as cmd from './commands.ts'
import {
    type CardInfo,
    type CardType,
    type LedOptions,
    type ReadOptions,
    type WriteOptions,
    type FullReadResult,
    type MifareBlock,
    type ReaderEvents,
    MIFARE_1K_BLOCKS,
    MIFARE_1K_SECTORS,
    MIFARE_BLOCK_SIZE,
    MIFARE_DEFAULT_KEY,
    POLL_INTERVAL,
    LED_RED,
    LED_GREEN,
    LED_RED_BLINK,
    LED_GREEN_BLINK,
    LED_RED_INIT,
    LED_GREEN_INIT,
    LED_RED_BLINK_ENABLE,
    LED_GREEN_BLINK_ENABLE,
    EP_BULK_IN
} from './types.ts'

function detectCardType(atr: Buffer): CardType {
    // ACR122U ATR for contactless cards follows PC/SC Part 3 format:
    // 3B 8F 80 01 80 4F 0C A0 00 00 03 06 03 XX YY 00 00 00 00 ZZ
    // Where XX = card standard, YY = card type
    // Standard byte XX: 0x03 = ISO 14443A
    // Card type byte YY for ISO 14443A:
    //   0x01 = MIFARE 1K
    //   0x02 = MIFARE 4K
    //   0x03 = MIFARE Ultralight
    //   0x26 = MIFARE Mini

    // Find the AID A0 00 00 03 06 in ATR
    const aidMarker = Buffer.from([0xa0, 0x00, 0x00, 0x03, 0x06])
    const aidIdx = atr.indexOf(aidMarker)
    if (aidIdx >= 0 && aidIdx + 8 <= atr.length) {
        const standard = atr[aidIdx + 5]
        // Card name is a 2-byte field (PC/SC Part 3)
        const cardNameHi = atr[aidIdx + 6]
        const cardNameLo = atr[aidIdx + 7]
        const cardName = ((cardNameHi ?? 0) << 8) | (cardNameLo ?? 0)
        if (standard === 0x03) {
            // ISO 14443A
            if (cardName === 0x0001) return 'mifare-1k'
            if (cardName === 0x0002) return 'mifare-4k'
            if (cardName === 0x0003) return 'mifare-ultralight'
        }
    }
    return 'unknown'
}

function blockToSector(block: number): number {
    if (block < 128) return Math.floor(block / 4)
    return 32 + Math.floor((block - 128) / 16)
}

function sectorTrailerBlock(sector: number): number {
    if (sector < 32) return sector * 4 + 3
    return 128 + (sector - 32) * 16 + 15
}

function sectorFirstBlock(sector: number): number {
    if (sector < 32) return sector * 4
    return 128 + (sector - 32) * 16
}

function sectorBlockCount(sector: number): number {
    return sector < 32 ? 4 : 16
}

export class ACR122U extends EventEmitter {
    private usb: UsbDevice
    private ccid: CcidTransport
    private pollTimer: ReturnType<typeof setInterval> | null = null
    private reconnectTimer: ReturnType<typeof setInterval> | null = null
    private _connected = false
    private _cardPresent = false
    private _currentCard: CardInfo | null = null
    private _devicePath?: string

    constructor() {
        super()
        this.usb = new UsbDevice()
        this.ccid = new CcidTransport(this.usb)
    }

    get connected(): boolean {
        return this._connected
    }

    get cardPresent(): boolean {
        return this._cardPresent
    }

    get currentCard(): CardInfo | null {
        return this._currentCard
    }

    /** Open connection to ACR122U */
    open(devicePath?: string): void {
        this._devicePath = devicePath
        this.usb.open(devicePath)

        // USB reset clears all device state from previous sessions
        this.usb.resetDevice()
        // After reset, must re-open the device
        this.usb.close()
        this.usb.open(devicePath)

        this.usb.detachKernelDriver()
        this.usb.claimInterface()

        this._connected = true
        this.emit('connect')

        // Power on the contactless interface
        this.ccid.powerOn()
    }

    /** Close connection and clean up */
    close(): void {
        this.stopListening()
        this.stopReconnect()

        if (this._connected) {
            try {
                this.ccid.powerOff()
            } catch {
                // ignore errors during shutdown
            }
            this.usb.close()
            this._connected = false
            this._cardPresent = false
            this._currentCard = null
        }
    }

    /** Get reader firmware version */
    firmware(): string {
        this.ensureConnected()
        const resp = this.ccid.transmit(cmd.getFirmwareVersion())
        if (!this.ccid.isSuccess(resp)) {
            throw new Error('Failed to get firmware version')
        }
        return resp.data.toString('ascii')
    }

    /** Get UID of current card */
    getUid(): Buffer {
        this.ensureConnected()
        const resp = this.ccid.transmit(cmd.getUid())
        if (!this.ccid.isSuccess(resp)) {
            throw new Error('Failed to get UID - is a card present?')
        }
        const {success, data} = cmd.checkSW(resp.data)
        if (!success) {
            throw new Error('Get UID failed: card not present or not responding')
        }
        return Buffer.from(data)
    }

    /** Check if a card is on the reader */
    isCardPresent(): boolean {
        this.ensureConnected()
        return this.ccid.isCardPresent()
    }

    /** Power on the card and get ATR */
    powerOnCard(): CcidResponse {
        this.ensureConnected()
        return this.ccid.powerOn()
    }

    /** Detect card and return info */
    detectCard(): CardInfo | null {
        this.ensureConnected()
        if (!this.ccid.isCardPresent()) return null

        // Power on to get ATR
        const powerResp = this.ccid.powerOn()
        if (!this.ccid.isSuccess(powerResp)) return null

        try {
            const uid = this.getUid()
            const type = detectCardType(powerResp.data)
            return {
                uid,
                uidHex: uid.toString('hex').toUpperCase(),
                atr: powerResp.data,
                type
            }
        } catch {
            return null
        }
    }

    /** Send raw APDU and return response */
    transmit(apdu: Buffer): {data: Buffer; sw1: number; sw2: number; success: boolean} {
        this.ensureConnected()
        const resp = this.ccid.transmit(apdu)
        if (!this.ccid.isSuccess(resp)) {
            throw new Error(`CCID command failed: status=${resp.status} error=${resp.error}`)
        }
        return cmd.checkSW(resp.data)
    }

    /** Load authentication key into reader */
    loadKey(key: Buffer = MIFARE_DEFAULT_KEY, slot = 0): void {
        const resp = this.transmit(cmd.loadKey(slot, key))
        if (!resp.success) {
            throw new Error(
                `Failed to load key: SW=${resp.sw1.toString(16)}${resp.sw2.toString(16)}`
            )
        }
    }

    /** Authenticate a MIFARE sector */
    authenticateSector(
        sector: number,
        keyType: 'A' | 'B' = 'A',
        key: Buffer = MIFARE_DEFAULT_KEY,
        keySlot = 0
    ): void {
        this.loadKey(key, keySlot)
        const block = sectorFirstBlock(sector)
        const resp = this.transmit(cmd.authenticate(block, keyType, keySlot))
        if (!resp.success) {
            throw new Error(
                `Authentication failed for sector ${sector}: SW=${resp.sw1.toString(16)}${resp.sw2.toString(16)}`
            )
        }
    }

    /** Read a single MIFARE block (16 bytes) */
    readBlock(blockNumber: number): Buffer {
        const resp = this.transmit(cmd.readBlock(blockNumber))
        if (!resp.success) {
            throw new Error(
                `Read block ${blockNumber} failed: SW=${resp.sw1.toString(16)}${resp.sw2.toString(16)}`
            )
        }
        if (resp.data.length !== MIFARE_BLOCK_SIZE) {
            throw new Error(
                `Partial read on block ${blockNumber}: got ${resp.data.length} bytes, expected ${MIFARE_BLOCK_SIZE}`
            )
        }
        return resp.data
    }

    /** Write 16 bytes to a MIFARE block */
    writeBlock(blockNumber: number, data: Buffer): void {
        if (blockNumber === 0) {
            throw new Error('Block 0 is manufacturer block and cannot be written')
        }
        const resp = this.transmit(cmd.writeBlock(blockNumber, data))
        if (!resp.success) {
            throw new Error(
                `Write block ${blockNumber} failed: SW=${resp.sw1.toString(16)}${resp.sw2.toString(16)}`
            )
        }
    }

    /**
     * Full read of entire MIFARE 1K tag.
     * Reads ALL 64 blocks. If ANY block fails, the entire read is discarded.
     * No partial results are ever returned.
     */
    fullRead(options: ReadOptions = {}): FullReadResult {
        this.ensureConnected()

        const key = options.key ?? MIFARE_DEFAULT_KEY
        const keyType = options.keyType ?? 'A'
        const sectors = options.sectors ?? Array.from({length: MIFARE_1K_SECTORS}, (_, i) => i)

        const uid = this.getUid()
        const blocks: MifareBlock[] = []
        const allData: Buffer[] = []

        for (const sector of sectors) {
            // Authenticate sector
            this.authenticateSector(sector, keyType, key)

            const firstBlock = sectorFirstBlock(sector)
            const blockCount = sectorBlockCount(sector)

            for (let i = 0; i < blockCount; i++) {
                const absBlock = firstBlock + i
                const data = this.readBlock(absBlock)

                // Enforce full read - data MUST be exactly 16 bytes
                if (data.length !== MIFARE_BLOCK_SIZE) {
                    throw new Error(
                        `Partial read detected on block ${absBlock}. `
                            + `Full read aborted - discarding all data.`
                    )
                }

                blocks.push({
                    sector,
                    block: i,
                    absoluteBlock: absBlock,
                    data: Buffer.from(data)
                })
                allData.push(data)
            }
        }

        return {
            uid,
            uidHex: uid.toString('hex').toUpperCase(),
            blocks,
            raw: Buffer.concat(allData)
        }
    }

    /**
     * Write data to multiple blocks.
     * Authenticates per-sector as needed.
     */
    fullWrite(startBlock: number, data: Buffer, options: WriteOptions = {}): void {
        this.ensureConnected()

        const key = options.key ?? MIFARE_DEFAULT_KEY
        const keyType = options.keyType ?? 'A'

        if (data.length % MIFARE_BLOCK_SIZE !== 0) {
            throw new Error(`Data length must be a multiple of ${MIFARE_BLOCK_SIZE}`)
        }

        const numBlocks = data.length / MIFARE_BLOCK_SIZE
        let lastAuthSector = -1

        for (let i = 0; i < numBlocks; i++) {
            const blockNum = startBlock + i
            const sector = blockToSector(blockNum)
            const trailer = sectorTrailerBlock(sector)

            // Skip sector trailer blocks
            if (blockNum === trailer) {
                throw new Error(`Cannot write to sector trailer block ${blockNum}`)
            }

            // Skip manufacturer block
            if (blockNum === 0) {
                throw new Error('Cannot write to manufacturer block 0')
            }

            // Re-authenticate if sector changed
            if (sector !== lastAuthSector) {
                this.authenticateSector(sector, keyType, key)
                lastAuthSector = sector
            }

            const blockData = data.subarray(i * MIFARE_BLOCK_SIZE, (i + 1) * MIFARE_BLOCK_SIZE)
            this.writeBlock(blockNum, blockData)
        }
    }

    /** Control LEDs */
    led(options: LedOptions): void {
        this.ensureConnected()

        let state = 0
        let t1 = 0
        let t2 = 0
        let repeat = 0
        let buzzer = 0

        // Final state (static LED)
        if (options.red) state |= LED_RED_INIT | LED_RED
        if (options.green) state |= LED_GREEN_INIT | LED_GREEN

        // Blink configuration
        if (options.blink) {
            if (options.blink.red) {
                state |= LED_RED_BLINK_ENABLE | LED_RED_BLINK
            }
            if (options.blink.green) {
                state |= LED_GREEN_BLINK_ENABLE | LED_GREEN_BLINK
            }
            // Duration in units of ~100ms
            t1 = Math.min(255, Math.round((options.blink.t1Duration ?? 500) / 100))
            t2 = Math.min(255, Math.round((options.blink.t2Duration ?? 500) / 100))
            repeat = Math.min(255, options.blink.repeat ?? 3)

            if (options.blink.buzzerOnT1) buzzer |= 0x01
            if (options.blink.buzzerOnT2) buzzer |= 0x02
        }

        this.transmit(cmd.ledControl(state, t1, t2, repeat, buzzer))
    }

    /** Control buzzer during card detection */
    buzzer(enabled: boolean): void {
        this.ensureConnected()
        this.transmit(cmd.buzzerControl(enabled ? 0xff : 0x00))
    }

    /** Start listening for card events via polling */
    listen(interval = POLL_INTERVAL): void {
        this.ensureConnected()
        this.stopListening()

        this.pollTimer = setInterval(() => {
            try {
                const present = this.ccid.isCardPresent()

                if (present && !this._cardPresent) {
                    // Card just arrived
                    this._cardPresent = true
                    const card = this.detectCard()
                    if (card) {
                        this._currentCard = card
                        this.emit('card', card)
                    }
                } else if (!present && this._cardPresent) {
                    // Card just removed
                    this._cardPresent = false
                    this._currentCard = null
                    this.emit('card:removed')
                }
            } catch (err) {
                // Device may have disconnected
                this.handleDisconnect(err as Error)
            }
        }, interval)
    }

    /** Stop listening for card events */
    stopListening(): void {
        if (this.pollTimer) {
            clearInterval(this.pollTimer)
            this.pollTimer = null
        }
    }

    /** Enable automatic reconnection */
    enableReconnect(interval = 2000): void {
        this.stopReconnect()
        this.reconnectTimer = setInterval(() => {
            if (!this._connected) {
                try {
                    this.open(this._devicePath)
                    // Restart listening if it was active
                    if (this.pollTimer === null && this.listenerCount('card') > 0) {
                        this.listen()
                    }
                } catch {
                    // Still disconnected, will retry
                }
            }
        }, interval)
    }

    /** Stop automatic reconnection */
    stopReconnect(): void {
        if (this.reconnectTimer) {
            clearInterval(this.reconnectTimer)
            this.reconnectTimer = null
        }
    }

    private handleDisconnect(err: Error): void {
        this.stopListening()
        this._connected = false
        this._cardPresent = false
        this._currentCard = null

        try {
            this.usb.close()
        } catch {
            // already closed
        }

        this.emit('disconnect')
        this.emit('error', err)
    }

    private ensureConnected(): void {
        if (!this._connected) {
            throw new Error('Reader not connected. Call open() first.')
        }
    }
}
