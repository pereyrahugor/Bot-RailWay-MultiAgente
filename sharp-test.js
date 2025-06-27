import sharp from 'sharp';

sharp('assets/sample.png')
  .resize(100)
  .toBuffer()
  .then(() => console.log('✅ Sharp funciona correctamente en Windows'))
  .catch(err => console.error('❌ Error de sharp:', err));