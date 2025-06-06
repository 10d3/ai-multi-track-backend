import sys
import os
import gc
import logging
from pathlib import Path
from spleeter.separator import Separator
import librosa
import soundfile as sf
import numpy as np

# Set up logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

def process_audio_chunks(audio_path, chunk_duration=30, overlap=2):
    """
    Process audio in chunks to handle long files and reduce memory usage.
    
    Args:
        audio_path: Path to input audio file
        chunk_duration: Duration of each chunk in seconds
        overlap: Overlap between chunks in seconds
    
    Returns:
        Generator yielding (chunk_data, sample_rate, start_time)
    """
    # Load audio metadata without loading the full file
    duration = librosa.get_duration(path=audio_path)
    sr = librosa.get_samplerate(audio_path)
    
    logger.info(f"Audio duration: {duration:.2f}s, Sample rate: {sr}Hz")
    
    start_time = 0
    while start_time < duration:
        end_time = min(start_time + chunk_duration, duration)
        
        # Load chunk with overlap for smooth transitions
        chunk_start = max(0, start_time - overlap)
        chunk_end = min(duration, end_time + overlap)
        
        logger.info(f"Processing chunk: {start_time:.1f}s - {end_time:.1f}s")
        
        # Load only the required chunk
        chunk_audio, _ = librosa.load(
            audio_path, 
            sr=sr, 
            offset=chunk_start, 
            duration=chunk_end - chunk_start,
            mono=False
        )
        
        yield chunk_audio, sr, start_time, end_time, chunk_start
        
        # Clean up memory
        del chunk_audio
        gc.collect()
        
        start_time = end_time

def separate_audio(input_audio_path, output_directory, chunk_duration=30):
    """
    Separate audio using Spleeter with chunking for long files and CPU optimization.
    
    Args:
        input_audio_path: Path to input audio file
        output_directory: Directory to save separated stems
        chunk_duration: Duration of chunks in seconds for processing
    """
    try:
        # Validate input
        input_path = Path(input_audio_path)
        if not input_path.exists():
            raise FileNotFoundError(f"Input file not found: {input_audio_path}")
        
        # Create output directory
        output_path = Path(output_directory)
        output_path.mkdir(parents=True, exist_ok=True)
        
        # Initialize Spleeter with CPU-friendly settings
        logger.info("Initializing Spleeter...")
        separator = Separator(
            'spleeter:2stems-16kHz',  # Lower sample rate for CPU processing
            multiprocess=False,       # Disable multiprocessing for stability
            mwf=False                # Disable multichannel Wiener filter for speed
        )
        
        # Check if file is short enough to process directly
        duration = librosa.get_duration(path=input_audio_path)
        
        if duration <= 60:  # Process short files normally
            logger.info("Processing short audio file directly...")
            separator.separate_to_file(input_audio_path, output_directory)
            logger.info("Separation completed successfully!")
            return
        
        # Process long files in chunks
        logger.info(f"Processing long audio file ({duration:.1f}s) in chunks...")
        
        # Initialize output arrays
        vocals_full = None
        accompaniment_full = None
        sample_rate = None
        
        for i, (chunk_audio, sr, start_time, end_time, chunk_start) in enumerate(
            process_audio_chunks(input_audio_path, chunk_duration)
        ):
            sample_rate = sr
            
            # Ensure chunk is in the right format for Spleeter
            if chunk_audio.ndim == 1:
                chunk_audio = chunk_audio.reshape(-1, 1)
            elif chunk_audio.ndim == 2 and chunk_audio.shape[0] == 2:
                chunk_audio = chunk_audio.T  # Transpose if channels are first dimension
            
            # Separate the chunk
            logger.info(f"Separating chunk {i+1}...")
            waveforms = separator.separate(chunk_audio)
            
            # Extract vocals and accompaniment
            vocals_chunk = waveforms['vocals']
            accompaniment_chunk = waveforms['accompaniment']
            
            # Initialize full arrays on first iteration
            if vocals_full is None:
                vocals_full = vocals_chunk.copy()
                accompaniment_full = accompaniment_chunk.copy()
            else:
                # Concatenate chunks
                vocals_full = np.vstack([vocals_full, vocals_chunk])
                accompaniment_full = np.vstack([accompaniment_full, accompaniment_chunk])
            
            # Clean up chunk data
            del chunk_audio, waveforms, vocals_chunk, accompaniment_chunk
            gc.collect()
        
        # Save the separated audio
        base_name = input_path.stem
        vocals_path = output_path / f"{base_name}_vocals.wav"
        accompaniment_path = output_path / f"{base_name}_accompaniment.wav"
        
        logger.info("Saving separated audio files...")
        
        # Save vocals
        if vocals_full.shape[1] == 1:
            sf.write(vocals_path, vocals_full.flatten(), sample_rate)
        else:
            sf.write(vocals_path, vocals_full, sample_rate)
        
        # Save accompaniment
        if accompaniment_full.shape[1] == 1:
            sf.write(accompaniment_path, accompaniment_full.flatten(), sample_rate)
        else:
            sf.write(accompaniment_path, accompaniment_full, sample_rate)
        
        logger.info(f"Separation completed! Files saved:")
        logger.info(f"  Vocals: {vocals_path}")
        logger.info(f"  Accompaniment: {accompaniment_path}")
        
    except Exception as e:
        logger.error(f"Error during audio separation: {str(e)}")
        raise

def main():
    if len(sys.argv) < 3 or len(sys.argv) > 4:
        print("Usage: python separate_audio.py <input_audio_path> <output_directory> [chunk_duration]")
        print("  chunk_duration: Optional, duration in seconds for processing chunks (default: 30)")
        sys.exit(1)

    input_audio_path = sys.argv[1]
    output_directory = sys.argv[2]
    chunk_duration = int(sys.argv[3]) if len(sys.argv) == 4 else 30

    # Validate chunk duration
    if chunk_duration < 10:
        print("Warning: Chunk duration should be at least 10 seconds for good results")
    
    logger.info(f"Starting audio separation...")
    logger.info(f"Input: {input_audio_path}")
    logger.info(f"Output: {output_directory}")
    logger.info(f"Chunk duration: {chunk_duration}s")
    
    try:
        separate_audio(input_audio_path, output_directory, chunk_duration)
    except Exception as e:
        logger.error(f"Failed to separate audio: {str(e)}")
        sys.exit(1)

if __name__ == "__main__":
    main()