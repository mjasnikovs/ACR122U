# acr122u

Raw USB driver for the ACR122U NFC reader. No native dependencies — pure FFI over Linux USBFS via
[Bun](https://bun.sh).

## Requirements

- **Linux** (uses USBFS directly)
- **Bun** >= 1.0.0
- **ACR122U** NFC reader connected via USB

## Install

```bash
bun add acr122u
```

## Quick Start

```ts
import {ACR122U} from 'acr122u'

const reader = new ACR122U()
reader.open()

console.log('Firmware:', reader.firmware())

if (reader.isCardPresent()) {
    const uid = reader.getUid()
    console.log('Card UID:', uid.toString('hex').toUpperCase())

    // Read entire MIFARE 1K tag
    const dump = reader.fullRead()
    console.log(`Read ${dump.blocks.length} blocks`)
}

reader.close()
```

## API

### `ACR122U`

High-level reader class (extends `EventEmitter`).

| Method                                       | Description                                       |
| -------------------------------------------- | ------------------------------------------------- |
| `open(devicePath?)`                          | Connect to reader (auto-detects if no path given) |
| `close()`                                    | Disconnect and clean up                           |
| `firmware()`                                 | Get firmware version string                       |
| `getUid()`                                   | Get card UID as `Buffer`                          |
| `isCardPresent()`                            | Check if a card is on the reader                  |
| `detectCard()`                               | Detect card and return `CardInfo`                 |
| `readBlock(block)`                           | Read a single 16-byte MIFARE block                |
| `writeBlock(block, data)`                    | Write 16 bytes to a block                         |
| `fullRead(options?)`                         | Read entire MIFARE 1K tag (all 64 blocks)         |
| `fullWrite(startBlock, data, options?)`      | Write data across multiple blocks                 |
| `authenticateSector(sector, keyType?, key?)` | Authenticate a MIFARE sector                      |
| `loadKey(key?, slot?)`                       | Load auth key into reader                         |
| `led(options)`                               | Control LEDs and buzzer                           |
| `buzzer(enabled)`                            | Enable/disable buzzer on card detection           |
| `listen(interval?)`                          | Start polling for card events                     |
| `stopListening()`                            | Stop polling                                      |
| `transmit(apdu)`                             | Send raw APDU command                             |

### Events

```ts
reader.on('card', card => {
    /* card placed */
})
reader.on('card:removed', () => {
    /* card removed */
})
reader.on('connect', () => {
    /* reader connected */
})
reader.on('disconnect', () => {
    /* reader disconnected */
})
reader.on('error', err => {
    /* error occurred */
})
```

### Low-Level Access

```ts
import {UsbDevice, CcidTransport, getFirmwareVersion} from 'acr122u'

const usb = new UsbDevice()
usb.open('/dev/bus/usb/001/002')
usb.detachKernelDriver()
usb.claimInterface()

const ccid = new CcidTransport(usb)
ccid.powerOn()

const resp = ccid.transmit(getFirmwareVersion())
```

## CLI

```bash
bunx acr122u info           # Reader & card info
bunx acr122u uid            # Print card UID
bunx acr122u read           # Full tag dump
bunx acr122u read --sector 1 --json
bunx acr122u write 4 48656C6C6F576F726C642100000000
bunx acr122u watch          # Continuous card scanning
bunx acr122u led red        # Set LED (red|green|both|off|blink)
bunx acr122u beep           # Short buzzer beep
bunx acr122u raw FF00480000 # Send raw APDU
```

## Permissions

The reader is accessed via `/dev/bus/usb/`. You need read/write access:

```bash
# Option 1: Run with sudo
sudo bun src/cli.ts info

# Option 2: udev rule (persistent)
echo 'SUBSYSTEM=="usb", ATTR{idVendor}=="072f", ATTR{idProduct}=="2200", MODE="0666"' | \
  sudo tee /etc/udev/rules.d/99-acr122u.rules
sudo udevadm control --reload-rules
# Replug the reader
```

## Architecture

```
CLI  ->  ACR122U (reader.ts)  ->  CcidTransport  ->  UsbDevice  ->  Linux USBFS (libc FFI)
                                  APDU Commands
```

- **UsbDevice** — raw USB bulk I/O via `libc.so.6` FFI (open, ioctl, close)
- **CcidTransport** — CCID protocol framing (power on/off, transmit APDUs)
- **Commands** — APDU builders for MIFARE operations, LED/buzzer control
- **ACR122U** — high-level API with card detection, sector auth, event polling

## License

MIT
