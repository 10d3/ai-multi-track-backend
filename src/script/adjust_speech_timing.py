#!/usr/bin/env python3
"""
Audio Tempo Adjuster
Adjusts audio tempo to fit a target duration using FFmpeg's atempo filter.
"""

import subprocess
import sys
import os
from pathlib import Path

def get_audio_duration(input_file):
    """Get the duration of an audio file using ffprobe."""
    try:
        cmd = [
            'ffprobe', '-v', 'quiet', 
            '-show_entries', 'format=duration', 
            '-of', 'csv=p=0', 
            input_file
        ]
        
        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
        duration = float(result.stdout.strip())
        return duration
        
    except subprocess.CalledProcessError as e:
        raise RuntimeError(f"Error getting audio duration: {e.stderr}")
    except Exception as e:
        raise RuntimeError(f"Error: {e}")

def create_tempo_filters(tempo):
    """Create atempo filter chain for large tempo adjustments."""
    if tempo <= 2.0:
        return [tempo]
        
    # Break down large tempo into multiple stages
    filters = []
    remaining_tempo = tempo
    
    while remaining_tempo > 2.0:
        filters.append(2.0)
        remaining_tempo /= 2.0
        
    if remaining_tempo > 1.0:
        filters.append(remaining_tempo)
        
    return filters

def adjust_audio_tempo(input_file, target_duration, output_file):
    """
    Adjust audio tempo to fit target duration.
    
    Args:
        input_file: Path to input audio file
        target_duration: Target duration in seconds
        output_file: Path to output audio file
        
    Returns:
        dict: Processing information including actual tempo used
    """
    
    # Validate inputs
    if not os.path.exists(input_file):
        raise FileNotFoundError(f"Input file not found: {input_file}")
        
    if target_duration <= 0:
        raise ValueError("Target duration must be positive")
    
    # Get current duration
    current_duration = get_audio_duration(input_file)
    print(f"Current duration: {current_duration:.3f} seconds")
    print(f"Target duration: {target_duration:.3f} seconds")
    
    # Calculate required tempo
    required_tempo = current_duration / target_duration
    print(f"Required tempo: {required_tempo:.3f}")
    
    # Clamp to valid range
    clamped_tempo = max(0.5, min(100.0, required_tempo))
    
    if clamped_tempo != required_tempo:
        print(f"Tempo clamped from {required_tempo:.3f} to {clamped_tempo:.3f}")
    
    # Only adjust if tempo difference is significant (>5%)
    if abs(clamped_tempo - 1.0) <= 0.05:
        print("Tempo adjustment not needed (<5% difference)")
        # Just copy the file
        import shutil
        shutil.copy2(input_file, output_file)
        return {
            'tempo_applied': 1.0,
            'tempo_required': required_tempo,
            'processed': False,
            'current_duration': current_duration,
            'target_duration': target_duration
        }
    
    # Create tempo filter chain
    tempo_filters = create_tempo_filters(clamped_tempo)
    
    # Build atempo filter chain
    atempo_chain = ','.join([f'atempo={tempo:.6f}' for tempo in tempo_filters])
    print(f"Applying tempo filters: {atempo_chain}")
    
    # Build FFmpeg command
    cmd = [
        'ffmpeg', '-y', '-i', input_file,
        '-af', atempo_chain,
        output_file
    ]
    
    # Run FFmpeg
    try:
        result = subprocess.run(
            cmd, 
            capture_output=True, 
            text=True, 
            check=True
        )
        
        print(f"Audio processing completed successfully!")
        print(f"Output saved to: {output_file}")
        
        # Verify output duration
        final_duration = get_audio_duration(output_file)
        print(f"Final duration: {final_duration:.3f} seconds")
        
        return {
            'tempo_applied': clamped_tempo,
            'tempo_required': required_tempo,
            'processed': True,
            'current_duration': current_duration,
            'target_duration': target_duration,
            'final_duration': final_duration,
            'duration_difference': abs(final_duration - target_duration)
        }
        
    except subprocess.CalledProcessError as e:
        raise RuntimeError(f"FFmpeg error: {e.stderr}")

def main():
    if len(sys.argv) != 4:
        print("Usage: python adjust_speech_timing.py <input_file> <target_duration> <output_file>")
        print("  input_file: Path to input audio file")
        print("  target_duration: Target duration in seconds")
        print("  output_file: Path to output audio file")
        sys.exit(1)
    
    input_file = sys.argv[1]
    target_duration = float(sys.argv[2])
    output_file = sys.argv[3]
    
    try:
        result = adjust_audio_tempo(input_file, target_duration, output_file)
        print(f"Processing complete: {result}")
        
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()