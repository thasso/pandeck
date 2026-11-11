"""The vault's YubiKey helper (plan Task-1395, `pivChild.ts`).

JSON lines on stdin and stdout, one answer per request:

- {"op": "public", "slot": "9d"} -> {"ok": true, "spki": <base64 DER>}
- {"op": "verify", "pin": ...} -> {"ok": true} | {"error": "wrong_pin",
  "triesLeft": n} | {"error": "blocked"}
- {"op": "ecdh", "slot": "9d", "epk": <base64 uncompressed point>}
  -> {"ok": true, "secret": <base64>}
- any failure: {"error": "no_device" | "no_key" | "failed"}

It never writes the PIN or an exception's text anywhere, and exits when stdin
closes. Only yubikit, ykman and cryptography, as Debian's python3-ykman ships.
"""

import base64
import json
import sys


def reply(answer):
    sys.stdout.write(json.dumps(answer) + "\n")
    sys.stdout.flush()


def main():
    try:
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.asymmetric import ec
        from ykman.pcsc import list_devices
        from yubikit.core.smartcard import ApduError, SmartCardConnection
        from yubikit.piv import SLOT, InvalidPinError, PivSession
    except Exception:
        for _ in sys.stdin:
            reply({"error": "failed"})
        return

    connection = None
    session = None

    def open_session():
        devices = list_devices()
        if len(devices) != 1:
            return None, None
        opened = devices[0].open_connection(SmartCardConnection)
        return opened, PivSession(opened)

    def slot_of(message):
        return SLOT(int(str(message.get("slot")), 16))

    def handle(message):
        nonlocal connection, session
        op = message.get("op")
        if session is None:
            connection, session = open_session()
            if session is None:
                return {"error": "no_device"}
        if op == "public":
            slot = slot_of(message)
            try:
                key = session.get_slot_metadata(slot).public_key
            except Exception:
                key = session.get_certificate(slot).public_key()
            der = key.public_bytes(
                serialization.Encoding.DER,
                serialization.PublicFormat.SubjectPublicKeyInfo,
            )
            return {"ok": True, "spki": base64.b64encode(der).decode()}
        if op == "verify":
            pin = message.get("pin")
            message.clear()
            if not isinstance(pin, str):
                return {"error": "failed"}
            if session.get_pin_attempts() == 0:
                return {"error": "blocked"}
            try:
                session.verify_pin(pin)
            except InvalidPinError as err:
                left = err.attempts_remaining
                if left == 0:
                    return {"error": "blocked"}
                return {"error": "wrong_pin", "triesLeft": left}
            finally:
                pin = None
            return {"ok": True}
        if op == "ecdh":
            peer = ec.EllipticCurvePublicKey.from_encoded_point(
                ec.SECP256R1(), base64.b64decode(str(message.get("epk")))
            )
            try:
                secret = session.calculate_secret(slot_of(message), peer)
            except ApduError as err:
                if err.sw in (0x6A82, 0x6A80, 0x6A88):
                    return {"error": "no_key"}
                return {"error": "failed"}
            return {"ok": True, "secret": base64.b64encode(secret).decode()}
        return {"error": "failed"}

    try:
        for line in sys.stdin:
            try:
                message = json.loads(line)
                answer = (
                    handle(message)
                    if isinstance(message, dict)
                    else {"error": "failed"}
                )
            except Exception:
                answer = {"error": "failed"}
            message = None
            line = None
            reply(answer)
    finally:
        if connection is not None:
            try:
                connection.close()
            except Exception:
                pass


if __name__ == "__main__":
    try:
        main()
    except Exception:
        sys.exit(1)
