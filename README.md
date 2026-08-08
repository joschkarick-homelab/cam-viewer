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
Tapo C100/C200 ──tapo://──► go2rtc  (Scrypted-VM, 192.168.2.10)
                            │  ├─ HomeKit
                            │  └─ :1984 / :8555
                            │
                            ▼  /api
                   cam-viewer-Container  (LXC, Port 8091)
                    nginx: PWA + /api-Proxy
                            │
                            ▼
                        NPMplus  (TLS + authentik)
                            │
                            ▼
                     cam.DEINE-DOMAIN.tld
```

WebRTC-Medien laufen am Proxy vorbei direkt zu `go2rtc:8555` — das geht
nur intern. Von außen bleibt MSE, das komplett durch den Proxy fließt.

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

### 2. App deployen

Läuft automatisch per GitHub Actions (siehe [Deployment](#deployment)).
Einmalig die Secrets im Repo setzen, dann deployt jeder Push auf `main`
von selbst.

Manuell anstoßen geht über **Actions → Build & Push Docker Image →
Run workflow**.

### 3. NPMplus

Proxy Host für `cam.DEINE-DOMAIN.tld` anlegen:

| Feld | Wert |
|---|---|
| Forward Hostname/IP | LXC-IP |
| Forward Port | `8091` (bzw. dein `HOST_PORT`) |
| Websockets Support | **an** |
| SSL | Zertifikat + Force SSL |

Inhalt von `deploy/npmplus-advanced.conf` unter **Advanced → Custom
Nginx Configuration** einfügen und `AUTHENTIK_IP` ersetzen.

Internes DNS muss `cam.DEINE-DOMAIN.tld` auf die **LAN-IP von NPMplus**
zeigen (Split-Horizon). Sonst laufen interne Geräte über den
Internet-Umweg und bekommen fälschlich den authentik-Login.

### 4. HomeKit umziehen (optional)

Cams **zuerst** aus Scrypteds HomeKit-Bridge entfernen — ein Gerät kann
nur mit einem Ökosystem gepairt sein. Dann in der Home-App über
„Weitere Optionen → Code eingeben" die PINs aus `go2rtc.yaml` nutzen.

Erst wenn das läuft, Scrypted endgültig abschalten.

---

## Deployment

Gleiches Muster wie `color-dices`: GitHub baut ein Image, schiebt es
nach GHCR und startet den Stack per Tailscale-SSH in der LXC neu.

```
push auf main
   └─► build.yml    Vite-Build → nginx-Image → ghcr.io/joschkarick/cam-viewer
          └─► deploy.yml   Tailscale → scp compose+env → docker compose up -d
```

Der Container liefert nicht nur die statischen Dateien aus, sondern
reicht auch `/api` an go2rtc weiter. Das ist Absicht: dadurch liegen
Same-Origin-Setup und die kritischen WebSocket-Timeouts versioniert im
Repo statt handgetippt in einem NPMplus-Textfeld — und werden bei jedem
Deploy automatisch mit ausgerollt.

### Einmalig einzurichten

Das Repo liegt unter `joschkarick/`, nicht unter `joschkarick-homelab/`.
Die vorhandenen Secrets greifen hier also **nicht** — sie müssen für
dieses Repo neu gesetzt werden.

**Settings → Secrets and variables → Actions → Secrets:**

| Secret | Beispiel | Anmerkung |
|---|---|---|
| `TS_OAUTH_CLIENT_ID` | | wie bei color-dices |
| `TS_OAUTH_SECRET` | | wie bei color-dices |
| `DEPLOY_USER` | `root` | wie bei color-dices |
| `DEPLOY_HOST` | LXC im Tailnet | wie bei color-dices |
| `HOST_PORT` | `8091` | frei, darf nicht mit Qwixx (8090) kollidieren |
| `GO2RTC_HOST` | `192.168.2.10:1984` | **neu** — die Scrypted-VM |

**→ Variables:**

| Variable | Beispiel |
|---|---|
| `DEPLOY_PATH` | `/opt/stacks/cam-viewer` |

Außerdem: das GHCR-Package nach dem ersten Build auf **privat** stellen
und der LXC Lesezugriff geben (Deploy-Token oder `docker login ghcr.io`),
falls sie nicht ohnehin eingeloggt ist.

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
