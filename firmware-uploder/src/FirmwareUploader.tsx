/// <reference types="w3c-web-serial" />
import { useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import { ESPLoader, Transport } from 'esptool-js'
import './FirmwareUploader.css'

type Board = 'arduino-mega' | 'esp'

const BOARD_LABELS: Record<Board, string> = {
  'arduino-mega': 'Arduino Mega',
  esp: 'ESP8266 / ESP32',
}

const BOARD_EXT: Record<Board, string> = {
  'arduino-mega': '.elf',
  esp: '.bin',
}

const BAUDRATES = ['9600', '57600', '115200', '230400', '460800'] as const
type Baudrate = (typeof BAUDRATES)[number]

type Status =
  | { kind: 'idle' }
  | { kind: 'error' | 'info' | 'success'; text: string }

function fileMatchesBoard(file: File, board: Board): boolean {
  return file.name.toLowerCase().endsWith(BOARD_EXT[board])
}

function toHex4(n: number | undefined): string {
  return n === undefined ? '—' : '0x' + n.toString(16).padStart(4, '0').toUpperCase()
}

function FirmwareUploader() {
  const [board, setBoard] = useState<Board | ''>('')
  const [baudrate, setBaudrate] = useState<Baudrate>('115200')
  const [file, setFile] = useState<File | null>(null)
  const [offset, setOffset] = useState('0x0')
  const [port, setPort] = useState<SerialPort | null>(null)
  const [portInfo, setPortInfo] = useState<{ vid?: number; pid?: number } | null>(null)
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const [busy, setBusy] = useState(false)
  const [log, setLog] = useState('')
  const [progress, setProgress] = useState<number | null>(null)
  const transportRef = useRef<Transport | null>(null)

  const appendLog = (chunk: string) => setLog((prev) => prev + chunk)

  const terminal = {
    clean: () => setLog(''),
    writeLine: (data: string) => appendLog(data + '\n'),
    write: (data: string) => appendLog(data),
  }

  const handleConnect = async () => {
    if (!('serial' in navigator)) {
      setStatus({
        kind: 'error',
        text: 'Web Serial API not supported. Use Chrome or Edge over HTTPS / localhost.',
      })
      return
    }
    try {
      const selected = await navigator.serial.requestPort()
      const info = selected.getInfo()
      setPort(selected)
      setPortInfo({ vid: info.usbVendorId, pid: info.usbProductId })
      setStatus({ kind: 'success', text: 'Device selected.' })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (!/no port selected/i.test(msg)) {
        setStatus({ kind: 'error', text: `Connect failed: ${msg}` })
      }
    }
  }

  const handleDisconnect = async () => {
    try {
      await transportRef.current?.disconnect()
    } catch {
      /* ignore */
    }
    transportRef.current = null
    setPort(null)
    setPortInfo(null)
    setStatus({ kind: 'idle' })
  }

  const handleBoardChange = (e: ChangeEvent<HTMLSelectElement>) => {
    setBoard(e.target.value as Board | '')
    setFile(null)
    setStatus({ kind: 'idle' })
  }

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const picked = e.target.files?.[0] ?? null
    setFile(picked)
    if (picked && board && !fileMatchesBoard(picked, board)) {
      setStatus({ kind: 'error', text: 'Invalid file format for selected board' })
    } else {
      setStatus({ kind: 'idle' })
    }
  }

  const flashEsp = async (selectedPort: SerialPort, fwFile: File) => {
    setLog('')
    setProgress(0)

    const transport = new Transport(selectedPort, true)
    transportRef.current = transport

    const esploader = new ESPLoader({
      transport,
      baudrate: parseInt(baudrate, 10),
      terminal,
    })

    const chip = await esploader.main()
    appendLog(`\nDetected chip: ${chip}\n`)

    const addr = parseInt(offset, 16)
    if (Number.isNaN(addr)) throw new Error(`Invalid offset: ${offset}`)

    const data = new Uint8Array(await fwFile.arrayBuffer())

    await esploader.writeFlash({
      fileArray: [{ data, address: addr }],
      flashSize: 'keep',
      flashMode: 'keep',
      flashFreq: 'keep',
      eraseAll: false,
      compress: true,
      reportProgress: (_i, written, total) => {
        setProgress(Math.round((written / total) * 100))
      },
    })

    appendLog('\nFlash complete.\n')
    setStatus({ kind: 'success', text: `Uploaded ${fwFile.name} successfully` })
  }

  const handleUpload = async () => {
    if (!board) {
      setStatus({ kind: 'error', text: 'Please select a board first' })
      return
    }
    if (!baudrate) {
      setStatus({ kind: 'error', text: 'Please select a baudrate' })
      return
    }
    if (!file) {
      setStatus({ kind: 'error', text: 'Please upload a firmware file' })
      return
    }
    if (!fileMatchesBoard(file, board)) {
      setStatus({ kind: 'error', text: 'Invalid file format for selected board' })
      return
    }
    if (!port) {
      setStatus({ kind: 'error', text: 'Please connect a device first' })
      return
    }

    setBusy(true)
    setStatus({ kind: 'info', text: 'Uploading firmware...' })

    try {
      if (board === 'esp') {
        await flashEsp(port, file)
      } else {
        await new Promise((r) => setTimeout(r, 800))
        setStatus({
          kind: 'info',
          text: 'Arduino flashing is not implemented yet (UI only).',
        })
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setStatus({ kind: 'error', text: `Upload failed: ${msg}` })
    } finally {
      try {
        await transportRef.current?.disconnect()
      } catch {
        /* ignore */
      }
      transportRef.current = null
      setBusy(false)
    }
  }

  const accept = board ? BOARD_EXT[board] : undefined
  const showSummary = board && baudrate

  return (
    <div className="uploader">
      <h1>Firmware Uploader</h1>

      <div className="connect-row">
        {!port ? (
          <button
            type="button"
            className="connect-btn"
            onClick={handleConnect}
            disabled={busy}
          >
            Connect Device
          </button>
        ) : (
          <>
            <div className="port-info">
              <strong>Connected</strong>
              <span>
                VID {toHex4(portInfo?.vid)} · PID {toHex4(portInfo?.pid)}
              </span>
            </div>
            <button
              type="button"
              className="disconnect-btn"
              onClick={handleDisconnect}
              disabled={busy}
            >
              Disconnect
            </button>
          </>
        )}
      </div>

      <label className="field">
        <span>Board</span>
        <select value={board} onChange={handleBoardChange} disabled={busy}>
          <option value="">— Select a board —</option>
          <option value="arduino-mega">Arduino Mega</option>
          <option value="esp">ESP8266 / ESP32</option>
        </select>
      </label>

      <label className="field">
        <span>Baudrate</span>
        <select
          value={baudrate}
          onChange={(e) => setBaudrate(e.target.value as Baudrate)}
          disabled={busy}
        >
          {BAUDRATES.map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        <span>Firmware file{board ? ` (${BOARD_EXT[board]})` : ''}</span>
        <input
          key={board}
          type="file"
          accept={accept}
          onChange={handleFileChange}
          disabled={busy || !board}
        />
      </label>

      {board === 'esp' && (
        <label className="field">
          <span>Flash offset (hex)</span>
          <input
            type="text"
            value={offset}
            onChange={(e) => setOffset(e.target.value)}
            disabled={busy}
            placeholder="0x0"
          />
        </label>
      )}

      {showSummary && (
        <div className="summary">
          <div>
            <strong>Board:</strong> {BOARD_LABELS[board as Board]}
          </div>
          <div>
            <strong>Baudrate:</strong> {baudrate}
          </div>
          {file && (
            <div>
              <strong>File:</strong> {file.name}
            </div>
          )}
        </div>
      )}

      <button
        type="button"
        className="upload-btn"
        onClick={handleUpload}
        disabled={busy}
      >
        {busy ? 'Uploading…' : 'Upload'}
      </button>

      {progress !== null && (
        <div className="progress">
          <div className="progress-bar" style={{ width: `${progress}%` }} />
          <div className="progress-text">{progress}%</div>
        </div>
      )}

      {status.kind !== 'idle' && (
        <div className={`status status-${status.kind}`} role="status">
          {status.text}
        </div>
      )}

      {log && <pre className="log">{log}</pre>}
    </div>
  )
}

export default FirmwareUploader
