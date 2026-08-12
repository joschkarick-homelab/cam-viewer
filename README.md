# cam-viewer

Leichtgewichtige PWA, um die Tapo-Cams auf allen Geräten anzuschauen —
als Ersatz für Scrypted NVR. Eine Codebasis für iOS, iPadOS, macOS,
Windows, Android und das Fire Tablet.

Ausgelegt auf **Babycam-Betrieb**: Bildschirm bleibt an, Verbindungs-
abbrüche sind unübersehbar, und ein eingefrorenes Bild wird niemals als
Livebild dargestellt.

Bundle: ~4,0 kB JS + 1,2 kB CSS (gzip), kein Framework.

---

## Architektur

```
Tapo C100/C200 ──tapo://──► go2rtc  (Scrypted-VM, 192.168.2.166)
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

# Dienstbenutzer. Fehlt er, bricht der Start mit 217/USER ab.
id -u go2rtc >/dev/null 2>&1 || \
  useradd --system --no-create-home --shell /usr/sbin/nologin go2rtc

mkdir -p /etc/go2rtc && cp go2rtc/go2rtc.yaml /etc/go2rtc/
chown -R go2rtc:go2rtc /etc/go2rtc    # sonst kann der Dienst nicht lesen
chmod 600 /etc/go2rtc/go2rtc.yaml     # enthält das Cloud-Passwort

cp deploy/go2rtc.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now go2rtc
```

Die Config gehört bewusst dem Dienstbenutzer und nicht `root`: go2rtc
schreibt die HomeKit-Pairings dort hinein. Aus demselben Grund steht
`/etc/go2rtc` in den `ReadWritePaths` der Unit — `ProtectSystem=strict`
würde das sonst blockieren.

In `go2rtc.yaml` auszufüllen ist nur noch `TAPO_CLOUD_PASSWORD`. Die
LAN-IP der VM unter `webrtc.candidates` steht bereits auf
`192.168.2.166` — zieht die VM um, gehört sie dort **und** im Secret
`GO2RTC_HOST` geändert.

Vorher einmalig in der Tapo-App: **Ich → Tapo Lab → Third-Party
Compatibility → an.** Steht der Schalter aus, scheitert die Anmeldung
auch mit dem richtigen Passwort.

#### Welches Passwort?

Das deines **TP-Link-/Tapo-Kontos** — das mit der E-Mail-Adresse, mit
dem du dich in der App anmeldest.

| | wofür | wo |
|---|---|---|
| **Konto-Passwort** | `tapo://` | App-Login, nirgends ablesbar |
| **Kamerakonto** | `rtsp://` | Geräteeinstellungen → Erweitert |

Die beiden zu verwechseln ist der häufigste Grund, warum `tapo://`
scheitert. Das Konto-Passwort lässt sich nirgends anzeigen; wenn du es
nicht mehr weißt, in der App unter *Ich → Konto* zurücksetzen. Bei
geteilten Cams gilt das Passwort des Besitzer-Kontos.

Wer das Klartext-Passwort nicht auf der VM liegen haben will, trägt
stattdessen dessen Hash ein — `tapo://admin:<HASH in Großbuchstaben>@<IP>`.
Das `admin:` ist Pflicht: ohne Benutzername behandelt go2rtc den Wert
als Klartext-Passwort und hasht ihn ein zweites Mal, Ergebnis
`unauthorized`. Ob die Cam MD5 oder SHA256 will, entscheidet sie selbst
(`encrypt_type`) — also erst mit Klartext verifizieren, dass sie läuft,
dann umstellen.

Gegenüber der Kamera ist der Hash passwortäquivalent, aber das
TP-Link-Kontopasswort (und damit der Zugang zu allen TP-Link-Geräten)
steht dann nicht mehr in der Datei. Details in `go2rtc/go2rtc.yaml`.

**Erst weitermachen, wenn `http://<VM-IP>:1984` alle drei Cams mit Bild
und Ton zeigt.** Das trennt Kamera- von App-Problemen.

Klappt eine Cam partout nicht — Symptom `Unable to find token in
response` deutet auf eine Firmware, die das Protokoll nicht spricht —,
die vorbereitete `rtsp://`-Zeile aktivieren. Dann läuft alles außer dem
Mikrofon-Rückkanal.

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
   └─► build.yml    Vite-Build → nginx-Image → ghcr.io/joschkarick-homelab/cam-viewer
          └─► deploy.yml   Tailscale → scp compose+env → docker compose up -d
```

Der Container liefert nicht nur die statischen Dateien aus, sondern
reicht auch `/api` an go2rtc weiter. Das ist Absicht: dadurch liegen
Same-Origin-Setup und die kritischen WebSocket-Timeouts versioniert im
Repo statt handgetippt in einem NPMplus-Textfeld — und werden bei jedem
Deploy automatisch mit ausgerollt.

### Einmalig einzurichten

Das Repo liegt in derselben Org wie `color-dices` und nutzt dieselben
Secret-Namen. **Organization Secrets gelten aber nicht automatisch für
jedes Repo der Org.** Jedes hat unter *Repository access* entweder „All
repositories" oder „Selected repositories" stehen — im zweiten Fall muss
`cam-viewer` dort ausdrücklich eingetragen werden, sonst kommt der Wert
im Workflow als leerer String an.

Das ist die unauffälligste Fehlerquelle im ganzen Deploy: GitHub lässt
leere Inputs kommentarlos weg, und die Tailscale-Action meldet dann nur
„Please provide either an auth key, OAuth secret and tags…" — ohne zu
sagen, welcher Wert fehlt. Der Preflight-Schritt in `deploy.yml` fängt
das ab und nennt die fehlenden Namen.

**Settings → Secrets and variables → Actions → Secrets:**

| Secret | Beispiel | Anmerkung |
|---|---|---|
| `TS_OAUTH_CLIENT_ID` | | ggf. schon auf Org-Ebene da |
| `TS_OAUTH_SECRET` | | ggf. schon auf Org-Ebene da |
| `DEPLOY_USER` | `root` | ggf. schon auf Org-Ebene da |
| `DEPLOY_HOST` | LXC im Tailnet | ggf. schon auf Org-Ebene da |
| `HOST_PORT` | `8091` | **neu** — darf nicht mit Qwixx (8090) kollidieren |
| `GO2RTC_HOST` | `192.168.2.166:1984` | **neu** — **mit Port**, siehe unten |

**→ Variables:**

| Variable | Beispiel |
|---|---|
| `DEPLOY_PATH` | `/opt/apps/cam-viewer` |

**`GO2RTC_HOST` braucht den Port.** Der Wert landet unverändert in
`proxy_pass http://…;` — steht dort nur `192.168.2.166`, proxyt nginx
nach Port 80 statt 1984. Die App lädt dann ganz normal, weil die
statischen Dateien nichts mit dem Proxy zu tun haben, und nur die
Streams schlagen fehl. Ein Fehlerbild, das nach Kamera- oder
Netzwerkproblem aussieht und keines ist. Der Preflight prüft das Format
inzwischen ab.

Was im laufenden Container tatsächlich ankam, zeigt:

```bash
docker exec cam-viewer grep proxy_pass /etc/nginx/conf.d/default.conf
```

Und: **ein geändertes Secret wirkt erst beim nächsten Deploy.**
`stack.env` wird zur Deploy-Zeit gerendert und in die LXC kopiert; der
laufende Container kennt nur den Wert von damals. Nach dem Korrigieren
also *Actions → Deploy to Homelab → Run workflow*.

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

Ist eine Kachel nicht live, steht der letzte Fehlergrund klein darunter
— dieselbe Meldung landet mit Präfix `[cam-viewer/<cam>]` in der
Browser-Konsole. Auf dem Fire Tablet gibt es keine Dev-Tools, deshalb
steht sie auch auf der Kachel.

### Wenn kein Bild kommt

Von außen nach innen, jeder Schritt schließt eine Ebene aus:

| Test | Was er bedeutet |
|---|---|
| `?transport=mse` anhängen | läuft es damit, liegt es an WebRTC — also an `webrtc.candidates` oder Port 8555, nicht am Proxy |
| `http://<host>/api/streams` im Browser | JSON mit den Stream-Namen = der `/api`-Proxy erreicht go2rtc |
| `http://<VM-IP>:1984` direkt | go2rtcs eigene Oberfläche. Kein Bild hier = das Problem liegt vor der App |
| `journalctl -u go2rtc -f` auf der VM | die Logs, die nginx **nicht** zeigt |

Wichtig zur Einordnung: die Docker-Logs des Containers sind nginx-Logs.
Ein `200` auf `POST /api/webrtc` heißt nur, dass go2rtc eine SDP-Answer
geliefert hat — über den anschließenden Medienpfad sagt er nichts. Der
läuft bei WebRTC direkt zu Port 8555 und nie durch nginx. Ein kaputter
Medienpfad sieht in den Container-Logs deshalb aus wie Erfolg.

Der verräterische Fall ist die Meldung `ICE failed` in der Konsole:
Signalisierung in Ordnung, Medien kommen nicht durch. Fast immer zeigt
dann `webrtc.candidates` in `/etc/go2rtc/go2rtc.yaml` auf die falsche
IP. **Die Datei liegt auf der VM und wird nicht mitdeployt** — eine
Korrektur im Repo ändert dort nichts.

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

Deshalb prüft `watchdog.ts` im Sekundentakt zwei Lebenszeichen — aber
nicht gleichberechtigt:

| Signal | verfügbar | Aussagekraft |
|---|---|---|
| `framesDecoded` aus `getStats()` | nur WebRTC | beweist ein **dekodiertes Bild** |
| `video.currentTime` | beide Transporte | läuft auch bei reinem Ton weiter |

Wo `framesDecoded` verfügbar ist, entscheidet allein dieser Wert.
„Eines von beiden genügt" wäre hier eine Falle: bleibt das Video stehen,
während der Audiotrack weiterläuft, tickt `currentTime` munter weiter —
und die Kachel meldete „Live" zu einem eingefrorenen Standbild. Auf MSE,
wo es keinen Frame-Zähler gibt, bleibt `currentTime` das Kriterium.

Steht das maßgebliche Signal 3 s still, gilt der Stream als tot, das Bild
wird ausgegraut und der Reconnect startet (1s, 2s, 4s, 8s, dann alle 15 s).

**Bis zum ersten Bild gelten andere Regeln.** Vor dem ersten Frame
passiert einiges — go2rtc meldet sich bei der Cam an, ICE handelt einen
Pfad aus, DTLS gibt sich die Hand —, und das dauert bei WebRTC leicht
mehrere Sekunden, bei MSE fast nicht. Mit denselben 3 s würden wir eine
gesunde Verbindung abschießen, bevor sie liefern konnte, und der
Reconnect finge wieder von vorn an. Deshalb gilt in der Anlaufphase eine
Geduld von 12 s.

Die Kachel bleibt in dieser Zeit auf **Verbinde…**. Auf „Live" springt
sie erst, wenn tatsächlich ein Frame dekodiert wurde — eine ausgehandelte
Verbindung ist noch kein Livebild.

Und daran hängt der Fehlversuchszähler: er wird erst vom ersten Bild
zurückgesetzt, nicht schon von der geglückten Aushandlung. Sonst käme
eine Cam, die zwar aushandelt, aber nie ein Bild liefert, niemals in den
roten Zustand — jeder Reconnect setzte den Zähler auf null, und **der
Alarm bliebe für immer stumm**.

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
