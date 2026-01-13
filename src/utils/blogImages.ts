// Import blog images
import landscape from '../assets/blog/landscape.jpg';
import river from '../assets/blog/river.jpg';
import forest from '../assets/blog/forest.jpg';
import type { ImageMetadata } from 'astro';

// Map image filenames to imported images
export const blogImages: Record<string, ImageMetadata> = {
	'landscape.jpg': landscape,
	'river.jpg': river,
	'forest.jpg': forest,
};

// Helper function to get image by filename
export function getBlogImage(filename: string | undefined): ImageMetadata | undefined {
	if (!filename) return undefined;
	return blogImages[filename];
}
