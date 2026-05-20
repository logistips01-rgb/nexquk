# NexQuk — Sistema de control de cocina inteligente

PWA mobile-first que controla en tiempo real los 3 fuegos de la **Balay 3EB915LR** a través de un ESP32 y Firebase Realtime Database.

---

## Arquitectura

```
[ App PWA (móvil) ] ──── Firebase RTDB ──── [ ESP32 + skin capacitivo ]
                                                      │
                                              [ Vitrocerámica ]
```

La app **escribe** el estado de los fuegos en Firebase.  
El ESP32 **lee** Firebase por WiFi y activa los pads capacitivos físicamente.  
Funciona desde cualquier red (casa, trabajo, 4G).

---

## Despliegue en GitHub Pages

### 1. Crear el proyecto Firebase

1. Ve a [console.firebase.google.com](https://console.firebase.google.com) → **Nuevo proyecto**
2. Activa **Google Analytics** (opcional)
3. En el proyecto:
   - **Authentication** → Sign-in methods → **Google** → Activar
   - **Realtime Database** → Crear base de datos → Región `europe-west1`
   - **Realtime Database** → Reglas → Pega:

```json
{
  "rules": {
    "dispositivos": {
      "$deviceId": {
        ".read":  "auth != null",
        ".write": "auth != null"
      }
    },
    "recetas": {
      "$uid": {
        ".read":  "auth != null && auth.uid === $uid",
        ".write": "auth != null && auth.uid === $uid"
      }
    }
  }
}
```

4. **Configuración del proyecto** → **Tu aplicación web** → Añadir app web → copia los valores

### 2. Configurar la app

Edita `firebase-config.js` y reemplaza los placeholders:

```js
const firebaseConfig = {
  apiKey:            "AIza...",
  authDomain:        "mi-proyecto.firebaseapp.com",
  databaseURL:       "https://mi-proyecto-default-rtdb.europe-west1.firebasedatabase.app",
  projectId:         "mi-proyecto",
  storageBucket:     "mi-proyecto.firebasestorage.app",
  messagingSenderId: "123456789",
  appId:             "1:123...:web:abc..."
};
```

### 3. Añadir dominio autorizado en Firebase Auth

Firebase Console → Authentication → **Settings** → **Authorized domains** → Añade:
```
TU_USUARIO.github.io
```

### 4. Generar iconos PNG

Abre `icons/icon.svg` en un editor (Figma, Inkscape, etc.) y exporta:
- `icons/icon-192.png` → 192×192 px
- `icons/icon-512.png` → 512×512 px

O usa [svgtopng.com](https://svgtopng.com) / [realfavicongenerator.net](https://realfavicongenerator.net).

### 5. Publicar en GitHub Pages

```bash
git add .
git commit -m "Initial NexQuk build"
git push origin main
```

En el repo de GitHub → **Settings** → **Pages** → Source: **Deploy from branch** → `main` / `/ (root)`

La app quedará en: `https://TU_USUARIO.github.io/NOMBRE_REPO/`

---

## Estructura Firebase Realtime Database

```
/dispositivos/{deviceId}/
  estado/
    fuegos/
      trasero/       { activo, potencia, boost }
      delantera_izq/ { activo, potencia, boost }
      delantera_der/ { activo, potencia, boost }
    bloqueo_infantil: boolean
    ts: timestamp

  comando/           ← comandos puntuales (reservado para ESP32 v2)
    accion: string
    payload: object
    ts: timestamp

/recetas/{userId}/{recipeId}/
  id:           string
  version:      number
  nombre:       string
  foto_url:     string|null
  tiempo_total: number (segundos)
  dificultad:   "facil"|"media"|"dificil"
  personas:     number
  categorias:   string[]
  pasos: [
    {
      id:          string
      orden:       number
      nombre:      string
      duracion:    number (segundos)
      instruccion: string
      fuegos: {
        trasero:       { activo, potencia (0-17), boost }
        delantera_izq: { activo, potencia (0-17), boost }
        delantera_der: { activo, potencia (0-17), boost }
      }
    }
  ]
  metadatos:
    creado_por:      userId
    creado_en:       ISO8601
    actualizado_en:  ISO8601
    fuente:          "manual"|"api"
    fuente_url:      string|null
```

---

## Conexión del ESP32

El ESP32 necesita:
- Librería: [`Firebase-ESP-Client`](https://github.com/mobizt/Firebase-ESP-Client) de Mobizt
- Acceso WiFi
- El mismo `deviceId` configurado en la app

### Sketch básico (Arduino IDE)

```cpp
#include <WiFi.h>
#include <Firebase_ESP_Client.h>
#include "addons/TokenHelper.h"
#include "addons/RTDBHelper.h"

#define WIFI_SSID     "TU_WIFI"
#define WIFI_PASSWORD "TU_CONTRASEÑA"
#define API_KEY       "TU_FIREBASE_API_KEY"
#define DATABASE_URL  "https://TU_PROYECTO-default-rtdb.europe-west1.firebasedatabase.app"
#define DEVICE_ID     "cocina_casa"   // ← mismo que en la app

// Pines de los pads capacitivos (ajusta a tu PCB)
#define PIN_TRASERO_ON   4
#define PIN_TRASERO_UP   5
#define PIN_TRASERO_DOWN 6
// ... resto de pines

FirebaseData fbdo;
FirebaseAuth auth;
FirebaseConfig config;

int lastPotencia[3] = {0, 0, 0};
bool lastActivo[3]  = {false, false, false};

void setup() {
  Serial.begin(115200);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  while (WiFi.status() != WL_CONNECTED) delay(300);

  config.api_key    = API_KEY;
  config.database_url = DATABASE_URL;
  // Auth anónima — la app escribe con usuario, el ESP32 lee sin auth
  // Ajusta las reglas Firebase si quieres auth en el ESP32 también
  Firebase.begin(&config, &auth);
  Firebase.reconnectWiFi(true);

  // Streaming del estado
  String path = "/dispositivos/" DEVICE_ID "/estado";
  if (!Firebase.RTDB.beginStream(&fbdo, path))
    Serial.println("Stream error: " + fbdo.errorReason());
  Firebase.RTDB.setStreamCallback(&fbdo, streamCallback, streamTimeout);
}

void streamCallback(FirebaseStream data) {
  if (data.dataTypeEnum() == fb_esp_rtdb_data_type_json) {
    FirebaseJson &json = data.jsonObject();
    // Parsea y aplica la potencia a cada zona
    // Ejemplo para zona trasera:
    FirebaseJsonData result;
    json.get(result, "fuegos/trasero/potencia");
    int pot = result.intValue;
    json.get(result, "fuegos/trasero/activo");
    bool act = result.boolValue;
    applyZone(0, act, pot);
  }
}

void applyZone(int zone, bool activo, int potencia) {
  // Aquí envías los pulsos a los pads capacitivos
  // según la diferencia entre estado actual y deseado
}

void streamTimeout(bool timeout) {
  if (timeout) Serial.println("Stream timeout, reconectando...");
}

void loop() {
  // El stream es asíncrono, el loop puede hacer otras tareas
  delay(10);
}
```

---

## API v2 — Endpoints necesarios (para integración con recetario externo)

Cuando se implemente la API externa de recetas, deberá exponer:

| Método | Endpoint                      | Descripción                          |
|--------|-------------------------------|--------------------------------------|
| GET    | `/api/recipes`                | Listar recetas (paginado)            |
| GET    | `/api/recipes/{id}`           | Obtener receta por ID                |
| POST   | `/api/recipes/import`         | Importar receta a Firebase del usuario |
| GET    | `/api/recipes/search?q=`      | Búsqueda por nombre/categoría        |
| GET    | `/api/recipes/categories`     | Listar categorías disponibles        |

**Formato de respuesta esperado** (compatible con la estructura Firebase):
```json
{
  "id":          "string",
  "version":     1,
  "nombre":      "string",
  "foto_url":    "string|null",
  "tiempo_total": 0,
  "dificultad":  "facil|media|dificil",
  "personas":    2,
  "categorias":  ["string"],
  "pasos": [
    {
      "id":          "string",
      "orden":       0,
      "nombre":      "string",
      "duracion":    60,
      "instruccion": "string",
      "fuegos": {
        "trasero":       { "activo": true,  "potencia": 7, "boost": false },
        "delantera_izq": { "activo": false, "potencia": 0, "boost": false },
        "delantera_der": { "activo": false, "potencia": 0, "boost": false }
      }
    }
  ],
  "metadatos": {
    "fuente":     "api",
    "fuente_url": "https://recetario.example.com/receta/123"
  }
}
```

---

## Desarrollo local

```bash
# Cualquier servidor HTTP estático sirve (no abrir index.html como file://)
npx serve .
# o
python3 -m http.server 8080
```

Abre `http://localhost:8080` — usa el modo demo para probar sin Firebase.
