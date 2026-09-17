"""Browser-only speech-to-text catalogue and effective runtime metadata."""
CATALOG = {
    'provider': 'browser',
    'label': 'Whisper en este navegador',
    'note': 'El audio no sale del dispositivo. WebGPU usa la GPU; CPU usa WebAssembly.',
    'default_model': 'onnx-community/whisper-tiny',
    'models': [
        {
            'id': 'onnx-community/whisper-tiny',
            'label': 'Whisper tiny',
            'description': 'Más rápido y ligero; recomendado para conversación y móvil.',
            'devices': ['webgpu', 'wasm'],
        },
        {
            'id': 'onnx-community/whisper-base',
            'label': 'Whisper base',
            'description': 'Más preciso, con mayor descarga y latencia.',
            'devices': ['webgpu', 'wasm'],
        },
        {
            'id': 'onnx-community/whisper-small',
            'label': 'Whisper small',
            'description': 'Mejor calidad multilingüe. Aproximadamente 285 MiB en Q4; requiere WebGPU.',
            'devices': ['webgpu'],
        },
        {
            'id': 'onnx-community/whisper-large-v3-turbo',
            'label': 'Whisper large v3 turbo',
            'description': 'Máxima calidad local disponible. Aproximadamente 538 MiB cuantizado; requiere WebGPU con fp16.',
            'devices': ['webgpu'],
        },
    ],
}


def resolve(settings, config=None):
    """Describe the browser runtime selected for this call; the server never sees audio."""
    return {
        'provider': 'browser',
        'model': settings.stt_model,
        'reason': 'explicit' if settings.stt_device != 'auto' else 'auto_capability',
        'engine': 'Transformers.js · Whisper',
        'location': 'browser',
        'device': settings.stt_device,
        'compute_type': 'fp32 (WebGPU) / q8 (WASM)',
    }


def credential_state(config=None):
    return {}
