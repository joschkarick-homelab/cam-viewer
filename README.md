# cam-viewer

Leichtgewichtige PWA, um die Tapo-Cams auf allen Geräten anzuschauen —
als Ersatz für Scrypted NVR. Eine Codebasis für iOS, iPadOS, macOS,
Windows, Android und das Fire Tablet.

Ausgelegt auf **Babycam-Betrieb**: Bildschirm bleibt an, Verbindungs-
abbrüche sind unübersehbar, und ein eingefrorenes Bild wird niemals als
Livebild dargestellt.

Bundle: ~6,3 kB JS + 1,3 kB CSS (gzip), kein Framework.

---

## Architektur

```
Tapo C100/C200 ──rtsp://──► go2rtc  (Scrypted-VM, 192.168.2.166)
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

In `go2rtc.yaml` auszufüllen sind **Kamerakonto und Passwort** für die
`rtsp://`-Zeilen — anzulegen in der Tapo-App unter *Geräteeinstellungen
→ Erweitert → Kamerakonto*.

> **Warum rtsp:// und nicht tapo://?** `tapo://` liefert go2rtc keine
> fmtp-Zeile, also weder SPS noch PPS. go2rtc schreibt dann einen
> Platzhalter in den MP4-Container (`pkg/mp4/muxer.go`: `sps = {0x67,
> 0x42, 0x00, 0x0a, …}` — Baseline Level 1.0, 128×96). Chrome liest die
> echten Parameter aus dem Datenstrom nach; **Safari nicht** und bricht
> mit `MEDIA_ERR_DECODE` ab. Über MSE bleibt damit auf jedem
> Apple-Gerät das Bild schwarz. `rtsp://` liefert
> `sprop-parameter-sets` und damit ein korrektes Init-Segment.
>
> Der Preis ist der Mikrofon-Rückkanal, den es ohnehin noch nicht gibt.
> Kommt er, gehört `tapo://` als **zusätzlicher** Stream-Name daneben,
> nicht als Ersatz.

Die LAN-IP der VM unter `webrtc.candidates` steht bereits auf
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

Der Abschnitt „Welches Passwort?" oben betrifft nur die
auskommentierten `tapo://`-Zeilen. Für den Normalbetrieb über `rtsp://`
brauchst du ausschließlich das Kamerakonto.

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
| **Advanced → Custom Nginx Configuration** | **leer lassen** |

> **Nichts in das Advanced-Feld schreiben, was `location /` enthält.**
> NPMplus erzeugt diesen Block selbst (`proxy_host.conf`, Zeile 147).
> Ein zweiter davon lässt `nginx -t` mit `duplicate location "/"`
> scheitern. NPMplus benennt die Config dann in `.err` um, markiert den
> Host als **Offline** — und weil es den vHost damit gar nicht gibt,
> landet die Domain auf der NPMplus-Startseite statt bei der App.
> Dasselbe gilt für `location /outpost.goauthentik.io` und
> `@goauthentik_proxy_signin`: auch die erzeugt NPMplus selbst.

Die genaue Fehlermeldung steht im `nginx_err`-Feld des Hosts (in der
Oberfläche am Offline-Status) und in `docker logs npmplus`.

#### authentik

NPMplus hat authentik eingebaut, es braucht **keinen** handgeschriebenen
Block. Die Einstellung liegt aber an zwei Stellen, und die wichtigere ist
nicht im Proxy Host:

**1. In der `compose.yaml` von NPMplus** die Adresse des Outposts setzen
und den Container neu erzeugen:

```yaml
- "AUTH_REQUEST_AUTHENTIK_UPSTREAM=http://<authentik-IP>:<port>"
```

**2. Im Proxy Host** unter *Auth Request* `authentik` wählen.

Das Dropdown allein reicht nicht — ohne die Variable bleibt der Upstream
leer. Das Format ist streng: **Schema + Host + Port, kein Pfad.**
`/outpost.goauthentik.io` hängt NPMplus selbst an; steht der Pfad in der
Variablen, lehnt `envs.sh` sie beim Start mit einer entsprechenden
Meldung ab.

Der Port ist der, unter dem der Outpost antwortet — nicht zwingend der
der authentik-Oberfläche. NPMplus merkt in seiner `compose.yaml` an,
dass der Weg derzeit nur mit dem **eingebetteten** Outpost funktioniert;
bei einem eigenständigen Proxy-Outpost bleibt der Host zwar Online, der
Login-Redirect kommt aber nicht.

**HTTP 500 nach dem Aktivieren?** Dann hat der Outpost auf die
Prüfanfrage etwas geantwortet, mit dem nginx nichts anfangen kann.
`auth_request` kennt nur 2xx (durchlassen), 401/403 (ablehnen) — alles
andere wird zu 500. Die Zahl steht in `docker logs npmplus`:
`auth request unexpected status: …`.

Direkt nachstellen:

```bash
curl -i -H 'X-Forwarded-Host: cam.DEINE-DOMAIN.tld' \
  http://<authentik-IP>:<port>/outpost.goauthentik.io/auth/nginx
```

Der Header ist hier der entscheidende Teil, nicht Beiwerk. Der Outpost
sucht die Anwendung über den Host (`lookupApp` in
`internal/outpost/proxyv2/handlers.go`), und `GetHost` bevorzugt dabei
`X-Forwarded-Host` vor `Host`. NPMplus setzt den auf die App-Domain;
ohne den Header testest du gegen die IP von authentik und bekommst
zwangsläufig einen 404.

**Warum ein 404 und keine sprechende Meldung?** Weil der eingebettete
Outpost bei unbekanntem Host stillschweigend abgibt —
`HandleHost()` in `proxyv2.go` liefert schlicht `false`, und die
Anfrage geht an die Django-Oberfläche, die mit ihrer 404-Seite
antwortet. Die aussagekräftige Variante (`400` mit
`"no app for hostname"`) gibt es nur beim eigenständigen Outpost.

Ob der eingebettete Outpost überhaupt läuft, klärt dieser Aufruf — er
wird vor jeder App-Suche behandelt und ist von der Zuweisung unabhängig:

```bash
curl -i http://<authentik-IP>:<port>/outpost.goauthentik.io/ping
```

`204` heißt: Outpost lebt, es fehlt nur die App-Zuweisung. Kommt auch
hier eine HTML-404, ist gar kein eingebetteter Outpost aktiv
(`DISABLE_EMBEDDED_OUTPOST`) oder der Port zeigt nicht auf authentiks
Go-Listener.

`401` ist hier das gesunde Ergebnis. Kommt `404`, kennt der Outpost den
Host nicht. In authentik müssen dafür **drei** Dinge stehen:

1. **Proxy Provider**, Modus *Forward auth (single application)*,
   External host = `https://cam.DEINE-DOMAIN.tld` (mit Schema, ohne Pfad)
2. **Application**, die diesen Provider nutzt
3. **Zuweisung zum Outpost**: *Applications → Outposts →
   `authentik Embedded Outpost` → Edit → Feld Applications*

Schritt 3 passiert **nicht** automatisch und ist der übliche Grund für
den 404: die Anwendungsliste des eingebetteten Outposts ist anfangs
leer, er kann die Anfrage also keinem Provider zuordnen. Nach dem
Zuweisen lädt er selbstständig neu. Ob es gewirkt hat, sieht man in der
Outpost-Liste an der Spalte *Providers* — `-` heißt: keine Zuweisung.

Und noch eine Einstellung am Outpost: **`authentik_host` muss auf die
HTTPS-Adresse von authentik zeigen.** Der eingebettete Outpost nimmt
diesen Wert unverändert für die Login-URL im Browser
(`GetOIDCEndpoint` in `endpoint.go`). Steht dort eine `http://`-Adresse,
landet der Nutzer auf einer ungesicherten Anmeldeseite — und WebAuthn
bzw. Passkeys verweigern dort den Dienst, weil sie einen Secure Context
verlangen. In der Outpost-Liste steht der aktuelle Wert als Hinweis
unter dem Namen („Logging in via …").

#### Intern ohne Login

Über eine **Access List** (nicht über Advanced):

| Feld | Wert |
|---|---|
| Satisfy Any | **an** |
| Allow | `192.168.2.0/24` |
| Deny | `all` |

`satisfy any` steht im generierten `location /` vor den
`auth_request`-Direktiven — erfüllt ein Client eine der Bedingungen, ist
er durch. Eine LAN-IP genügt damit, von außen greift authentik.

#### Split-DNS

Internes DNS muss `cam.DEINE-DOMAIN.tld` auf die **LAN-IP von NPMplus**
zeigen. Sonst laufen interne Geräte über den Internet-Umweg und bekommen
fälschlich den Login.

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

### Privates GHCR-Package

Das Package sollte nach dem ersten Build auf **privat** stehen — die
Kamerabilder sind zwar nicht im Image, der Aufbau des Heimnetzes aber
schon (`nginx.conf`, `cams.json`). Ein privates Package heißt allerdings:
`docker compose pull` in der LXC scheitert mit

```
error from registry: denied
```

— eine Meldung, die nach einem falschen Tag aussieht und in Wahrheit
„nicht eingeloggt" bedeutet.

Der Deploy-Workflow löst das selbst: er reicht das ohnehin vorhandene
`GITHUB_TOKEN` über stdin per SSH an `docker login ghcr.io` durch und
meldet sich danach wieder ab. Das Token gilt nur für die Dauer des Laufs
und liegt weder in der Prozessliste noch dauerhaft in
`~/.docker/config.json`. Dafür braucht der Job `permissions: packages:
read` — ohne das darf `GITHUB_TOKEN` keine Packages lesen, auch nicht die
des eigenen Repos.

Wer stattdessen von Hand in der LXC pullen will, meldet sich einmalig mit
einem PAT (Scope `read:packages`) an:

```bash
echo '<PAT>' | docker login ghcr.io -u <github-user> --password-stdin
```

---

## Bedienung

Ein Tap auf **„Ton & Bildschirm an"** erledigt drei Dinge auf einmal:
AudioContext entsperren (nötig für den Alarm), Wake Lock anfordern und
den Ton der ersten Cam freigeben. Browser verlangen dafür eine echte
Nutzergeste — das lässt sich nicht automatisieren.

Tap auf eine Kachel → Vollbild.

Danach steht pro Kamera ein Schalter in der Leiste: **Ton lässt sich für
beliebig viele Cams gleichzeitig anschalten.** Zwei Kinderzimmer parallel
zu hören ist bei einer Babycam der eigentliche Zweck; ob drei Streams
gleichzeitig noch sinnvoll sind, entscheidest du.

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

**`Invalid port` beim `setRemoteDescription`?** Dann steht in
`webrtc.candidates` ein Eintrag mit `/tcp`-Suffix. go2rtc reicht den
ungeprüft als Portnummer ins SDP (`8555/tcp`), der Browser verwirft
daraufhin die *ganze* Answer, und **alle** Kameras bleiben schwarz.

Dort gehört nur `host:port` hin. Ein einziger Eintrag erzeugt bereits
Kandidaten für TCP **und** UDP — ein separater TCP-Eintrag ist nicht
nötig und existiert in dieser Form auch gar nicht.

Warum das in go2rtcs eigenem Player nicht auffällt: der nutzt
Trickle-ICE über WebSocket, bekommt jeden Kandidaten einzeln, und ein
unbrauchbarer fällt allein durch. Über den POST-Weg stehen alle in
einem Dokument — einer reißt alle mit. Die App wirft solche Zeilen
inzwischen selbst weg, damit ein Vertipper höchstens einen Netzwerkpfad
kostet.

Der verräterische Fall ist die Meldung `ICE failed` in der Konsole:
Signalisierung in Ordnung, Medien kommen nicht durch. Fast immer zeigt
dann `webrtc.candidates` in `/etc/go2rtc/go2rtc.yaml` auf die falsche
IP. **Die Datei liegt auf der VM und wird nicht mitdeployt** — eine
Korrektur im Repo ändert dort nichts.

### Als App installieren

**Voraussetzung ist HTTPS.** Über `http://<IP>:8091` bietet kein Browser
die Installation an, und Wake Lock bleibt ebenfalls aus — beides braucht
einen Secure Context. Es geht also erst nach Schritt 3 (NPMplus), unter
`https://cam.DEINE-DOMAIN.tld`.

| Plattform | Weg |
|---|---|
| **Windows** (Edge/Chrome) | Installationssymbol rechts in der Adresszeile, oder ⋯ → *Apps* → *Diese Website als App installieren* |
| **macOS** (Safari 17+) | *Ablage → Zum Dock hinzufügen* |
| **macOS** (Chrome/Edge) | Installationssymbol in der Adresszeile |
| **iOS/iPadOS** | Teilen → *Zum Home-Bildschirm* |
| **Android** | Menü → *App installieren* |

Chrome und Edge verlangen für das Angebot zusätzlich einen Service
Worker mit Fetch-Handler; Safari nicht. Deshalb liegt einer in
`app/public/sw.js` — **network-first**, nicht cache-first. Der übliche
PWA-Ansatz liefert die App-Shell aus dem Cache, was hier die falsche
Abwägung wäre: nach einem Deploy liefe alter Code weiter, und genau in
diesem Code stecken Watchdog, Ausgrauen und Alarm. Ein alter Stand, der
ein Standbild als Livebild zeigt, wäre schlimmer als eine Sekunde
Ladezeit. Der Cache greift nur, wenn das Netz gar nicht antwortet.

Als installierte App startet sie ohne Adresszeile in einem eigenen
Fenster (`display_override: standalone`), auf Mobilgeräten im Vollbild.

**Zum Danebenstellen am Schreibtisch** lohnt eine eigene
Browser-Profilinstanz oder eben die installierte App: Wake Lock hält den
Bildschirm nur an, solange das Fenster im Vordergrund ist. Minimiert oder
von einem Vollbildfenster verdeckt greift es nicht.

### URL-Parameter

| Parameter | Wirkung |
|---|---|
| `?sd=1` / `?sd=0` | VGA-Substream erzwingen bzw. abschalten |
| `?transport=webrtc\|mse` | Transport erzwingen |
| `?debug=1` / `?debug=0` | Diagnoseanzeige ein/aus |

Alles wird in `localStorage` gemerkt.

### Diagnose

`?debug=1` blendet unten eine Anzeige ein, die sich sekündlich
aktualisiert, und legt einen Knopf **Diagnose kopieren** in die Leiste.
Ein Tap legt alles als Text in die Zwischenablage:

- **Umgebung** — Build-Zeitstempel, User-Agent, Secure Context, ob
  `ManagedMediaSource` existiert, die Eingangswerte beider Heuristiken
  (`deviceMemory`, `hardwareConcurrency`) und der Inhalt von
  `localStorage`
- **Je Kachel** — Zustand, Fehlversuche, letzter Grund, benutzter
  Stream-Name, dazu `readyState`, `buffered`, `currentTime` und
  Bildgröße des Video-Elements
- **Je Transport** — bei MSE ausgehandelte und angebotene Codecs,
  empfangene Bytes, angehängte Blöcke, Zustand der MediaSource; bei
  WebRTC ICE-Zustände, empfangene Pakete, dekodierte Frames und der
  gewählte Kandidat
- **Verlauf** — jeder Zustandswechsel und Fehlversuch mit Zeitstempel,
  wodurch Muster wie „verbindet alle 15 s neu" direkt ablesbar sind

Der Build-Zeitstempel beantwortet dabei die Frage, die beim Einrichten
am häufigsten aufhält: **sieht dieses Gerät überhaupt den frisch
deployten Stand?**

Gedacht ist das für Handy und Fire Tablet, wo es keine Entwicklerkonsole
gibt. Ohne Secure Context — also über `http://<IP>:8091` — gibt es keine
Zwischenablage; dann zeigt der Knopf den Text zum Markieren an.

Die Anzeige wird erst bei Bedarf nachgeladen (eigener Chunk, ~1 kB) und
kostet im Normalbetrieb nichts.

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

**Der Codec-String von go2rtc stimmt bei `tapo://` nicht.** Er wird aus
der fmtp-Zeile der Quelle abgeleitet — die `tapo://` gar nicht liefert
(`pkg/tapo/producer.go` legt den Codec ohne `FmtpLine` an). go2rtcs
`GetProfileLevelID("")` fällt dann auf fest verdrahtete Werte zurück und
meldet für **jede** Tapo-Cam `avc1.640029`, also H.264 High 4.1,
unabhängig vom tatsächlichen Bitstrom.

Safari gleicht den deklarierten String gegen die SPS ab und lehnt bei
Abweichung mit `MEDIA_ERR_DECODE` ab (sichtbar als Bildgröße `128x96`);
Chrome sieht darüber hinweg. Das war die Ursache für „läuft in Chrome,
nicht in Safari".

`correctH264Codec()` in `transport.ts` liest deshalb Profil, Kompatibi-
lität und Level aus der `avcC`-Box des Init-Segments und ersetzt den
`avc1`-Teil, bevor der `SourceBuffer` entsteht. Der Audio-Teil bleibt
unangetastet. Schlägt der korrigierte String fehl, wird go2rtcs
ursprünglicher versucht.

**Codecliste nicht erweitern.** `supportedCodecs()` in `transport.ts`
entspricht Zeichen für Zeichen der Liste aus go2rtcs eigenem Player.
Hier stand zwischenzeitlich zusätzlich `avc1.42E01E` (H.264 Baseline),
gedacht fürs Fire Tablet. Bietet der Client ein Profil an, das die
Kamera nicht liefert, kann go2rtc den Stream falsch etikettieren — und
Safari lehnt das mit `MEDIA_ERR_DECODE` ab, wo Chrome großzügig
darüber hinwegsieht. H.264 handelt go2rtc ohnehin aus.

**Safari braucht einen eigenen MSE-Pfad.** Safari ab 17 (macOS wie iOS)
bringt `ManagedMediaSource` statt `MediaSource` mit. Die will per
`srcObject` angehängt werden statt per `createObjectURL`, und sie öffnet
sich erst, wenn das Video-Element wirklich Daten anfordert — also erst
nach `play()`. Beides steht in `transport.ts`; wer dort aufräumt, sollte
es wissen, denn der Fehler äußert sich nicht als Fehler, sondern als
ewiges „Verbinde…" ausschließlich in Safari.

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
