#!/usr/bin/env python3
"""
Audio Tempo Adjuster
Adjusts audio tempo to fit a target duration using Rubberband for high-quality time stretching.
"""

import subprocess
import sys
import os
import shutil
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

def check_rubberband():
    """Check if rubberband is available."""
    try:
        subprocess.run(['rubberband', '--help'], capture_output=True, check=True)
        return True
    except (subprocess.CalledProcessError, FileNotFoundError):
        return False

def adjust_audio_tempo(input_file, target_duration, output_file):
    """
    Adjust audio tempo to fit target duration using Rubberband for high-quality time stretching.
    
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
    
    # Check if rubberband is available
    if not check_rubberband():
        raise RuntimeError("Rubberband is not installed or not found in PATH. Please install rubberband-cli.")
    
    # Get current duration
    current_duration = get_audio_duration(input_file)
    print(f"Current duration: {current_duration:.3f} seconds")
    print(f"Target duration: {target_duration:.3f} seconds")
    
    # Calculate required tempo and stretch ratio
    required_tempo = current_duration / target_duration
    stretch_ratio = target_duration / current_duration  # Rubberband uses stretch ratios, not tempo
    
    print(f"Required tempo: {required_tempo:.3f}")
    print(f"Stretch ratio: {stretch_ratio:.3f}")
    
    # Clamp to reasonable range for quality (Rubberband can handle wider range than atempo)
    # But we still want to avoid extreme changes for speech quality
    min_stretch = 0.3  # ~3x faster (very fast speech)
    max_stretch = 3.0  # ~3x slower (very slow speech)
    
    clamped_stretch = max(min_stretch, min(max_stretch, stretch_ratio))
    clamped_tempo = 1.0 / clamped_stretch
    
    if abs(clamped_stretch - stretch_ratio) > 0.001:
        print(f"Stretch ratio clamped from {stretch_ratio:.3f} to {clamped_stretch:.3f}")
        print(f"Tempo clamped from {required_tempo:.3f} to {clamped_tempo:.3f}")
    
    # Only adjust if stretch difference is significant (>5%)
    if abs(clamped_stretch - 1.0) <= 0.05:
        print("Tempo adjustment not needed (<5% difference)")
        # Just copy the file
        shutil.copy2(input_file, output_file)
        return {
            'tempo_applied': 1.0,
            'tempo_required': required_tempo,
            'stretch_ratio': 1.0,
            'processed': False,
            'current_duration': current_duration,
            'target_duration': target_duration
        }
    
    print(f"Applying Rubberband time stretch: {clamped_stretch:.3f}")
    
    # Build Rubberband command with high-quality options for speech
    cmd = [
        'rubberband',
        '--time', str(clamped_stretch),  # Time stretch ratio
        '--pitch-hq',                    # High-quality pitch processing
        '--formant-corrected',           # Preserve formants for natural speech
        '--smoothing',                   # Smooth phase adjustment
        '--detector', 'compound',        # Better onset detection
        '--phase-laminar',              # Better phase coherence
        '--window-long',                # Longer analysis window for stability
        '--threads', '2',               # Use multiple threads
        input_file,
        output_file
    ]
    
    # Run Rubberband
    try:
        print(f"Running: {' '.join(cmd)}")
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
        
        duration_difference = abs(final_duration - target_duration)
        print(f"Duration difference: {duration_difference:.3f} seconds")
        
        return {
            'tempo_applied': clamped_tempo,
            'tempo_required': required_tempo,
            'stretch_ratio': clamped_stretch,
            'processed': True,
            'current_duration': current_duration,
            'target_duration': target_duration,
            'final_duration': final_duration,
            'duration_difference': duration_difference
        }
        
    except subprocess.CalledProcessError as e:
        # Fallback to FFmpeg atempo if Rubberband fails
        print(f"Rubberband failed: {e.stderr}")
        print("Falling back to FFmpeg atempo filter...")
        return fallback_to_atempo(input_file, required_tempo, output_file, current_duration, target_duration)

def fallback_to_atempo(input_file, tempo, output_file, current_duration, target_duration):
    """Fallback to FFmpeg atempo if Rubberband fails."""
    try:
        # Clamp tempo to atempo's valid range
        clamped_tempo = max(0.5, min(100.0, tempo))
        
        # Create atempo filter chain for large adjustments
        filters = []
        remaining_tempo = clamped_tempo
        
        while remaining_tempo > 2.0:
            filters.append(2.0)
            remaining_tempo /= 2.0
        
        while remaining_tempo < 0.5:
            filters.append(0.5)
            remaining_tempo /= 0.5
            
        if remaining_tempo != 1.0:
            filters.append(remaining_tempo)
        
        atempo_chain = ','.join([f'atempo={t:.6f}' for t in filters])
        print(f"Using atempo fallback: {atempo_chain}")
        
        cmd = [
            'ffmpeg', '-y', '-i', input_file,
            '-af', atempo_chain,
            output_file
        ]
        
        subprocess.run(cmd, capture_output=True, text=True, check=True)
        
        final_duration = get_audio_duration(output_file)
        
        return {
            'tempo_applied': clamped_tempo,
            'tempo_required': tempo,
            'stretch_ratio': 1.0 / clamped_tempo,
            'processed': True,
            'method': 'atempo_fallback',
            'current_duration': current_duration,
            'target_duration': target_duration,
            'final_duration': final_duration,
            'duration_difference': abs(final_duration - target_duration)
        }
        
    except subprocess.CalledProcessError as e:
        raise RuntimeError(f"Both Rubberband and FFmpeg atempo failed: {e.stderr}")

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