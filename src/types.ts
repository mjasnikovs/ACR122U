/** USB endpoint addresses for ACR122U */
export const EP_BULK_OUT = 0x02
export const EP_INTERRUPT_IN = 0x81
export const EP_BULK_IN = 0x82

/** ACR122U USB identifiers */
export const VENDOR_ID = 0x072f
export const PRODUCT_ID = 0x2200
export const INTERFACE_NUM = 0

/** Linux USBDEVFS ioctl numbers (x86_64) */
export const USBDEVFS_CLAIMINTERFACE = 0x8004550f
export const USBDEVFS_RELEASEINTERFACE = 0x80045510
export const USBDEVFS_BULK = 0xc0185502
export const USBDEVFS_IOCTL = 0xc0105512
export const USBDEVFS_DISCONNECT = 0x5516
export const USBDEVFS_CONNECT = 0x5517
export const USBDEVFS_RESET = 0x00005514

/** Linux open flags */
export const O_RDWR = 2

/** CCID message types - Host to Reader */
export const PC_TO_RDR_ICCPOWERON = 0x62
export const PC_TO_RDR_ICCPOWEROFF = 0x63
export const PC_TO_RDR_GETSLOTSTATUS = 0x65
export const PC_TO_RDR_XFRBLOCK = 0x6f

/** CCID message types - Reader to Host */
export const RDR_TO_PC_DATABLOCK = 0x80
export const RDR_TO_PC_SLOTSTATUS = 0x81
export const RDR_TO_PC_NOTIFYSLOTCHANGE = 0x50

/** CCID Status - ICC Status bits (0-1) */
export const ICC_STATUS_ACTIVE = 0x00
export const ICC_STATUS_INACTIVE = 0x01
export const ICC_STATUS_NOT_PRESENT = 0x02

/** CCID Status - Command Status bits (6-7) */
export const CMD_STATUS_SUCCESS = 0x00
export const CMD_STATUS_FAILED = 0x40
export const CMD_STATUS_TIME_EXT = 0x80

/** CCID header size */
export const CCID_HEADER_SIZE = 10

/** ACR122U APDU class byte */
export const ACR_CLA = 0xff

/** MIFARE constants */
export const MIFARE_1K_BLOCKS = 64
export const MIFARE_1K_SECTORS = 16
export const MIFARE_BLOCK_SIZE = 16
export const MIFARE_DEFAULT_KEY = Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff])
export const MIFARE_KEY_A = 0x60
export const MIFARE_KEY_B = 0x61

/** LED state flags */
export const LED_RED = 0x01
export const LED_GREEN = 0x02
export const LED_RED_BLINK = 0x04
export const LED_GREEN_BLINK = 0x08
export const LED_RED_INIT = 0x10
export const LED_GREEN_INIT = 0x20
export const LED_RED_BLINK_ENABLE = 0x40
export const LED_GREEN_BLINK_ENABLE = 0x80

/** USB transfer timeout in ms */
export const DEFAULT_TIMEOUT = 5000
export const POLL_INTERVAL = 250

/** Event types */
export type ReaderEvents = {
    card: [CardInfo]
    'card:removed': []
    error: [Error]
    connect: []
    disconnect: []
    data: [Buffer]
}

export interface CardInfo {
    uid: Buffer
    uidHex: string
    atr: Buffer
    type: CardType
}

export type CardType = 'mifare-1k' | 'mifare-4k' | 'mifare-ultralight' | 'ntag' | 'unknown'

export interface LedOptions {
    red?: boolean
    green?: boolean
    blink?: {
        red?: boolean
        green?: boolean
        t1Duration?: number
        t2Duration?: number
        repeat?: number
        buzzerOnT1?: boolean
        buzzerOnT2?: boolean
    }
}

export interface ReadOptions {
    key?: Buffer
    keyType?: 'A' | 'B'
    sectors?: number[]
}

export interface WriteOptions {
    key?: Buffer
    keyType?: 'A' | 'B'
}

export interface MifareBlock {
    sector: number
    block: number
    absoluteBlock: number
    data: Buffer
}

export interface FullReadResult {
    uid: Buffer
    uidHex: string
    blocks: MifareBlock[]
    raw: Buffer
}
