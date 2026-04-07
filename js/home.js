// Home page carousel functionality
document.addEventListener('DOMContentLoaded', function() {
  const carousel = document.querySelector('.carousel');
  if (!carousel) return;

  const slides = document.querySelectorAll('.carousel-slide');
  const prevBtn = document.querySelector('.carousel-btn.prev');
  const nextBtn = document.querySelector('.carousel-btn.next');
  const dots = document.querySelectorAll('.dot');

  let currentSlide = 0;
  let slideInterval;

  // Initialize carousel
  function initCarousel() {
    showSlide(currentSlide);
    startAutoPlay();
  }

  // Show specific slide
  function showSlide(index) {
    slides.forEach(slide => slide.classList.remove('active'));
    dots.forEach(dot => dot.classList.remove('active'));

    slides[index].classList.add('active');
    dots[index].classList.add('active');
  }

  // Next slide
  function nextSlide() {
    currentSlide = (currentSlide + 1) % slides.length;
    showSlide(currentSlide);
  }

  // Previous slide
  function prevSlide() {
    currentSlide = (currentSlide - 1 + slides.length) % slides.length;
    showSlide(currentSlide);
  }

  // Go to specific slide
  function goToSlide(index) {
    currentSlide = index;
    showSlide(currentSlide);
  }

  // Start auto-play
  function startAutoPlay() {
    slideInterval = setInterval(nextSlide, 5000); // Change slide every 5 seconds
  }

  // Stop auto-play
  function stopAutoPlay() {
    clearInterval(slideInterval);
  }

  // Event listeners
  if (prevBtn) {
    prevBtn.addEventListener('click', function() {
      prevSlide();
      stopAutoPlay();
      startAutoPlay(); // Restart auto-play
    });
  }

  if (nextBtn) {
    nextBtn.addEventListener('click', function() {
      nextSlide();
      stopAutoPlay();
      startAutoPlay(); // Restart auto-play
    });
  }

  // Dot navigation
  dots.forEach((dot, index) => {
    dot.addEventListener('click', function() {
      goToSlide(index);
      stopAutoPlay();
      startAutoPlay(); // Restart auto-play
    });
  });

  // Pause auto-play on hover
  carousel.addEventListener('mouseenter', stopAutoPlay);
  carousel.addEventListener('mouseleave', startAutoPlay);

  // Initialize
  initCarousel();
});