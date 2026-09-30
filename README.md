# ioBroker SOFAR Local

Lokaler ioBroker-Adapter zum Auslesen kompatibler SOFAR-Wechselrichter über einen LSW3-Logger mit SOLARMAN V5 über TCP.

> **Status:** Entwicklung / Community-Projekt. Getestet mit SOFAR HYD 4000-EP und LSW3.

## Funktionen

- lokale Kommunikation ohne SOLARMAN-Cloud-API
- SOFAR/SOLARMAN V5 über TCP, standardmäßig Port `8899`
- PV1/PV2 Spannung, Strom und Leistung
- PV-Gesamtleistung
- Batterie: Spannung, Strom, Leistung, SOC, SOH, Temperatur und Zyklen
- Netzleistung mit Bezug/Einspeisung
- Netzfrequenz, L1-Spannung und L1-Strom, soweit vom Gerät geliefert
- Hausverbrauch als Energiebilanz aus PV, Batterie und Netz
- Wechselrichter-Status und Leistung
- Energiezähler, soweit vom Registersatz des Geräts geliefert
- Rohregister und letzte Modbus-Antwort zur Diagnose
- FC3 mit FC4-Fallback

## Getestete Umgebung

- SOFAR HYD 4000-EP
- LSW3 Logger
- SOLARMAN V5 / TCP
- TCP-Port `8899`
- Modbus-Geräteadresse `1`

Die genaue Registerunterstützung und Skalierung kann je nach Wechselrichtermodell und Firmware abweichen.

## Installation

### ioBroker über TGZ

```bash
iobroker url /tmp/iobroker.sofar-local-0.4.3.tgz --host IOBroker --debug
```

### Konfiguration

In ioBroker unter **Instanzen → sofar-local** eine Instanz anlegen und konfigurieren:

- Logger-IP-Adresse
- TCP-Port
- Logger-Seriennummer
- Modbus-Geräteadresse
- Timeout
- Abfrageintervall

## Wichtige Datenpunkte

```text
sofar-local.0.photovoltaik.power
sofar-local.0.photovoltaik.mppt1Power
sofar-local.0.photovoltaik.mppt2Power
sofar-local.0.batterie.power
sofar-local.0.batterie.soc
sofar-local.0.netz.power
sofar-local.0.netz.importPower
sofar-local.0.netz.exportPower
sofar-local.0.verbrauch.power
sofar-local.0.verbrauch.registerPower
sofar-local.0.verbindung.online
```

### Hausverbrauch

Der zentrale berechnete Verbrauch verwendet die Vorzeichenkonvention:

- PV: positiv
- Batterieentladung: positiv
- Batterieladung: negativ
- Netzbezug: positiv
- Netzeinspeisung: negativ

Damit gilt:

```text
Hausverbrauch = PV + Batterieentladung/-ladung + Netzbezug/-einspeisung
```

Der Datenpunkt `verbrauch.differenz` zeigt die Abweichung zum optional vom Wechselrichter gemeldeten Verbrauchswert.

## Sicherheit und Datenschutz

Der Adapter benötigt keine SOLARMAN-Cloud-Zugangsdaten. IP-Adresse und Logger-Seriennummer werden ausschließlich lokal in der ioBroker-Instanz konfiguriert und sind nicht Bestandteil des Quellcodes.

## Lizenz

MIT – siehe [LICENSE](LICENSE).

## Haftung / Hinweis

Der Adapter ist ein Community-Projekt und wird ohne Gewähr bereitgestellt. Änderungen an Wechselrichter- oder Logger-Konfigurationen können die Kommunikation beeinflussen. Der Adapter führt ausschließlich Lesezugriffe auf die dokumentierten Modbus-Register aus.

## Mitmachen

Fehlerberichte und Pull Requests sind willkommen. Bitte bei Problemen möglichst folgende Informationen angeben:

- Wechselrichtermodell
- Logger-Modell und Firmware
- ioBroker-Version
- Node.js-Version
- relevante Adapter-Logzeilen
- verwendete Register bzw. Rohwerte

Keine privaten IP-Adressen, Seriennummern, Passwörter oder API-Schlüssel in Issues posten.
