# Highrise Music Bot - JavaScript

Icecast streamli muzik botu.

## Kurulum

```
npm install
```

## Baslatma

```
start.bat
```

Veya terminalde:
```
node bot.js
```

## Komutlar

| Komut | Aciklama |
|-------|----------|
| !play / -p `<sarki>` | Sarki cal |
| !stop | Durdur |
| !skip / -s | Atla |
| !queue / -q | Sirayi goster |
| !nowplaying / -np | Su an ne caliyor |
| !volume / -v `<0-100>` | Ses ayari |
| !clear | Sirayi temizle |
| !remove `<numara>` | Siradan cikar |

## Mimari

1. **Icecast** - Ses sunucusu (port 8000)
2. **Ngrok** - Tunnel ile Icecast'i aciga ac
3. **server.js** - Express sunucusu (port 3000)
4. **bot.js** - Highrise botu (komutlar + YouTube arama)
