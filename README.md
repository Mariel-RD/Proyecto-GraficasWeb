# Coin Thieves

Juego web con servidor Node.js, Socket.IO y guardado de jugadores/puntajes en MySQL.

## Requisitos

- Node.js instalado.
- XAMPP, WAMP o MySQL instalado.
- MySQL encendido antes de correr el servidor.
- phpMyAdmin para crear y revisar la base de datos.

## Configurar la base de datos

1. Abre phpMyAdmin.
2. Entra a la pestana **SQL**.
3. Copia y ejecuta el contenido de:

```text
database/schema.sql
```

Ese archivo crea la base de datos `coin_thieves` y las tablas `players` y `scores`.

## Configurar el archivo `.env`

En la raiz del proyecto, crea un archivo llamado `.env`.

Puedes copiar el contenido de `.env.example`:

```env
PORT=3000
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_USER=root
MYSQL_PASSWORD=
MYSQL_DATABASE=coin_thieves
```

Si en phpMyAdmin arriba aparece algo como `localhost:3307`, cambia el puerto:

```env
MYSQL_PORT=3307
```

Si aparece solo `localhost`, normalmente usa:

```env
MYSQL_PORT=3306
```

## Instalar dependencias

En la carpeta del proyecto:

```powershell
npm install
```

## Correr el juego

En PowerShell puede fallar `npm start` por politicas de ejecucion. En ese caso usa:

```powershell
npm.cmd start
```

Luego abre:

```text
http://localhost:3000/VENTANAS/menu_inicial/index.html
```

Tambien puedes usar:

```powershell
npm.cmd run play
```

Ese comando intenta liberar el puerto `3000`, abre el navegador y levanta el servidor.

## Revisar datos en phpMyAdmin

Despues de iniciar sesion y terminar una partida, puedes revisar:

```sql
USE coin_thieves;

SELECT * FROM players;
SELECT * FROM scores;
```

Cada cuenta de Facebook se guarda como un jugador distinto usando un ID como:

```text
facebook:123456789
```

Cada jugador tiene una sola puntuacion guardada. Si vuelve a jugar con la misma cuenta, se actualiza su registro.

## Limpiar la base para volver a probar

En phpMyAdmin, ejecuta:

```sql
USE coin_thieves;

DELETE FROM scores;
DELETE FROM players;

ALTER TABLE scores AUTO_INCREMENT = 1;
```

## Si no conecta a MySQL

Revisa:

- Que MySQL este encendido en XAMPP/WAMP.
- Que `MYSQL_PORT` sea el mismo puerto que muestra phpMyAdmin.
- Que exista la base `coin_thieves`.
- Que el usuario y contrasena en `.env` sean correctos.

Si MySQL no esta disponible, el servidor puede usar un respaldo local en:

```text
data/game-db.json
```

Ese archivo sirve para pruebas locales, pero esos datos no aparecen en phpMyAdmin.
