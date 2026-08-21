# Earth Texture Assets

All textures in this directory are sourced from NASA's publicly available
image library and are in the public domain. No attribution is legally required,
but the following documents the provenance of each file.

---

## earth-day.jpg

| Field       | Value |
|-------------|-------|
| Filename    | `earth-day.jpg` |
| Source URL  | https://eoimages.gsfc.nasa.gov/images/imagerecords/57000/57730/land_ocean_ice_2048.jpg |
| Creator     | NASA Goddard Space Flight Center, NASA Earth Observatory |
| Description | Blue Marble: Land, Ocean, Ice (2048 × 1024 equirectangular JPEG). Composited from MODIS data. Depicts land surface, sea ice, and ocean color. |
| License     | Public domain. NASA-produced images are not subject to copyright unless explicitly stated. See https://www.nasa.gov/multimedia/guidelines/index.html |
| Attribution | Optional courtesy credit: "NASA Earth Observatory" |

---

## earth-bump.jpg

| Field       | Value |
|-------------|-------|
| Filename    | `earth-bump.jpg` |
| Source URL  | https://eoimages.gsfc.nasa.gov/images/imagerecords/57000/57752/land_shallow_topo_2048.jpg |
| Creator     | NASA Goddard Space Flight Center, NASA Earth Observatory |
| Description | Blue Marble: Topographic Shading (2048 × 1024 equirectangular JPEG). Greyscale-style relief shading showing terrain elevation. Used as a bump map in Three.js `MeshPhongMaterial`. |
| License     | Public domain. |
| Attribution | Optional courtesy credit: "NASA Earth Observatory" |

---

## earth-specular.jpg

| Field       | Value |
|-------------|-------|
| Filename    | `earth-specular.jpg` |
| Source URL  | https://eoimages.gsfc.nasa.gov/images/imagerecords/57000/57752/land_shallow_topo_2048.jpg |
| Creator     | NASA Goddard Space Flight Center, NASA Earth Observatory |
| Description | Same topographic shading image used as a specular map proxy. Ocean areas are darker in this image, providing a rough land/water luminance difference that drives ocean highlight response in the shader. |
| License     | Public domain. |
| Attribution | Optional courtesy credit: "NASA Earth Observatory" |

---

## earth-clouds.jpg

| Field       | Value |
|-------------|-------|
| Filename    | `earth-clouds.jpg` |
| Source URL  | https://eoimages.gsfc.nasa.gov/images/imagerecords/57000/57747/cloud_combined_2048.jpg |
| Creator     | NASA Goddard Space Flight Center, NASA Earth Observatory |
| Description | Blue Marble: Cloud Cover (2048 × 1024 equirectangular JPEG). Combined cloud-mask image from MODIS Terra and Aqua satellites. Used as a cloud layer on a semi-transparent sphere. |
| License     | Public domain. |
| Attribution | Optional courtesy credit: "NASA Earth Observatory" |

---

## Usage notes

- All textures are equirectangular (geographic) projections covering the full
  globe from −180° to +180° longitude and −90° to +90° latitude.
- They are served locally by the Next.js static asset server from `/public/`
  and are never fetched from remote URLs at runtime.
- The cloud layer (earth-clouds.jpg) is a JPEG used with `alphaMap` on a
  separate semi-transparent `MeshPhongMaterial` sphere, providing a subtle
  cosmetic cloud effect. It does not represent real-time meteorological data.

## NASA imagery policy

NASA content used in a factual manner is not subject to copyright and may be
reproduced without further permission. Source:
https://www.nasa.gov/multimedia/guidelines/index.html
