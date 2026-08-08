# cam-viewer

Leichtgewichtige PWA, um die Tapo-Cams auf allen Geräten anzuschauen —
als Ersatz für Scrypted NVR. Eine Codebasis für iOS, iPadOS, macOS,
Windows, Android und das Fire Tablet.

Ausgelegt auf **Babycam-Betrieb**: Bildschirm bleibt an, Verbindungs-
abbrüche sind unübersehbar, und ein eingefrorenes Bild wird niemals als
Livebild dargestellt.

Bundle: ~3,7 kB JS + 1,1 kB CSS (gzip), kein Framework.

---

## Architektur

```
Tapo C100/C200  ──tapo://──►  go2rtc          (Scrypted-VM)
                              ├─ WebRTC :8555  ─┐
                              ├─ MSE/WS  :1984  ├─►  NPMplus  ──►  PWA
                              └─ HomeKit        ─┘   (TLS + authentik)
```

| | intern (192.168.2.0/24) | extern |
|---|---|---|
| Login | keiner | authentik |
| Transport | WebRTC | MSE über WSS |
| Latenz | ~0,3 s | ~1 s |

**Warum extern MSE?** WebRTC-Medien laufen direkt auf Port 8555 und
damit am Reverse Proxy — und an authentik — vorbei. Von außen müsstest
du diesen Port ungeschützt öffnen. MSE fließt komplett über die
bestehende WSS-Verbindung, also nur Port 443. Die App wählt selbst.

---

## Aufbau in vier Schritten

### 1. go2rtc auf der Scrypted-VM

```bash
wget -O /usr/local/bin/go2rtc \
  https://github.com/AlexxIT/go2rtc/releases/latest/download/go2rtc_linux_amd64
chmod +x /usr/local/bin/go2rtc
mkdir -p /etc/go2rtc && cp go2rtc/go2rtc.yaml /etc/go2rtc/
chmod 600 /etc/go2rtc/go2rtc.yaml     # enthält das Cloud-Passwort
cp deploy/go2rtc.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now go2rtc
```

In `go2rtc.yaml` ausfüllen: `TAPO_CLOUD_PASSWORD` und die LAN-IP der VM
unter `webrtc.candidates`.

**Erst weitermachen, wenn `http://<VM-IP>:1984` alle drei Cams mit Bild
und Ton zeigt.** Das trennt Kamera- von App-Problemen.

### 2. App bauen und ausliefern

```bash
cd app && npm ci && npm run build
rsync -a --delete dist/ root@<LXC>:/var/www/cam-viewer/
```

nginx in der LXC nach `deploy/app-nginx.conf` einrichten (Port 8080,
nur intern).

### 3. NPMplus

Proxy Host für `cam.DEINE-DOMAIN.tld` anlegen, Inhalt von
`deploy/npmplus-advanced.conf` unter **Advanced → Custom Nginx
Configuration** einfügen und die drei Platzhalter ersetzen.

Internes DNS muss `cam.DEINE-DOMAIN.tld` auf die **LAN-IP von NPMplus**
zeigen (Split-Horizon). Sonst laufen interne Geräte über den
Internet-Umweg und bekommen fälschlich den authentik-Login.

### 4. HomeKit umziehen (optional)

Cams **zuerst** aus Scrypteds HomeKit-Bridge entfernen — ein Gerät kann
nur mit einem Ökosystem gepairt sein. Dann in der Home-App über
„Weitere Optionen → Code eingeben" die PINs aus `go2rtc.yaml` nutzen.

Erst wenn das läuft, Scrypted endgültig abschalten.

---

## Bedienung

Ein Tap auf **„Ton & Bildschirm an"** erledigt drei Dinge auf einmal:
AudioContext entsperren (nötig für den Alarm), Wake Lock anfordern und
den Ton der ersten Cam freigeben. Browser verlangen dafür eine echte
Nutzergeste — das lässt sich nicht automatisieren.

Tap auf eine Kachel → Vollbild. Ton läuft immer nur auf einer Cam.

### Kachelzustände

| Anzeige | Bedeutung |
|---|---|
| 🟢 Live | Frames kommen an |
| 🟡 Verbinde… | Verbindungsaufbau |
| 🟡 Kein Bild | Stream steht — Bild wird ausgegraut, Reconnect läuft |
| 🔴 Verbindung weg | mehrere Fehlversuche, Rahmen pulsiert, **Alarm piept** |

Der Alarm verstummt erst, wenn keine Kamera mehr im roten Zustand ist.

### URL-Parameter

| Parameter | Wirkung |
|---|---|
| `?sd=1` / `?sd=0` | VGA-Substream erzwingen bzw. abschalten |
| `?transport=webrtc\|mse` | Transport erzwingen |

Beides wird in `localStorage` gemerkt.

`cams.json` liegt neben `index.html` und wird zur Laufzeit geladen —
Kameras umbenennen oder ergänzen braucht **keinen neuen Build**.

---

## Warum der Watchdog so gebaut ist

`RTCPeerConnection.connectionState` lügt. Der meldet minutenlang
`connected`, während längst keine Frames mehr ankommen — etwa nach
einem Cam-Neustart oder kurzem WLAN-Aussetzer. Bei einer Babycam ist
das der gefährlichste Zustand: ein Standbild sieht aus wie ein
schlafendes Kind.

Deshalb prüft `watchdog.ts` zwei unabhängige Lebenszeichen im
Sekundentakt — `video.currentTime` und `framesDecoded` aus `getStats()`.
Stehen beide 3 s still, gilt der Stream als tot, das Bild wird
ausgegraut und der Reconnect startet (1s, 2s, 4s, 8s, dann alle 15 s).

Der Deckel bei 15 s ist Absicht: unbegrenztes Backoff würde bedeuten,
dass die Cam nach längerem Ausfall erst Minuten später zurückkommt.

---

## Bekannte Grenzen

**iOS im Hintergrund.** Wischst du die PWA weg oder sperrst das iPhone,
suspendiert iOS sie — der Ton ist weg. Wake Lock hält den Bildschirm
an, solange die App im Vordergrund ist. Ein echter Hintergrund-Betrieb
wie bei nativen Apps ist im Web nicht möglich. Für „Tablet steht
daneben" irrelevant, für „Handy in der Hosentasche" nicht.

**Fire Tablet 7.** Silk ist beim Wake Lock unzuverlässig. Empfehlung:
*Fully Kiosk Browser* — hält den Bildschirm hart an, startet automatisch,
echter Kiosk-Modus. Das Gerät bekommt über die Heuristik automatisch den
VGA-Substream; notfalls `?sd=1` anhängen.

**Mikrofon.** Noch nicht implementiert. Die Quellen stehen aber bereits
auf `tapo://`, was den Rückkanal grundsätzlich ermöglicht — Tapo kann
nur ONVIF Profile S, über RTSP gäbe es keinen Backchannel. Nachrüsten
heißt: Signaling von `POST /api/webrtc` auf go2rtcs WebSocket-API
umstellen und einen `sendrecv`-Audio-Transceiver ergänzen.

**HomeKit-Audio** kostet CPU, weil HomeKit OPUS verlangt und Tapo
G.711 liefert — go2rtc transkodiert per FFmpeg. Wenn die VM knapp ist:
Audio in der HomeKit-Sektion weglassen und Ton nur über die App hören.

---

## Zum Tapo-Protokoll

`tapo://` verbindet **direkt zur Kamera** auf Port 8800, ohne
Cloud-Beteiligung. Aus `pkg/tapo/client.go`:

```go
"http://" + c.url.Host + "/stream"   // c.url.Host = LAN-IP der Cam
u.Host += ":8800"
```

Das Cloud-Passwort ist reines Credential: es wird lokal gehasht
(MD5 bzw. SHA256, je nach Firmware) und per RFC-7616-Digest gegen die
Kamera geprüft. Zur Laufzeit ist **kein Internet nötig** — die Cams
dürfen komplett gefirewallt sein.
