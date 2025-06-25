document.addEventListener('DOMContentLoaded', () => {
    // --- Gère le surlignage actif de la navigation en fonction du scroll ---
    const sections = document.querySelectorAll('section[id]');
    const navLinks = document.querySelectorAll('.navbar .nav-link');

    const navObserverOptions = {
        root: null, // observe par rapport au viewport
        rootMargin: '0px',
        threshold: 0.6 // La section doit être visible à 60% pour être active
    };

    const navObserver = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                const id = entry.target.getAttribute('id');
                
                navLinks.forEach(link => {
                    link.classList.remove('active');
                    if (link.getAttribute('href') === `#${id}`) {
                        link.classList.add('active');
                    }
                });
            }
        });
    }, navObserverOptions);

    sections.forEach(section => {
        navObserver.observe(section);
    });

    // --- Animation de comptage pour les statistiques ---
    const statsSection = document.querySelector('.stats');
    const statNumbers = document.querySelectorAll('.stat-number');

    const countUp = (el) => {
        const target = +el.getAttribute('data-target');
        const duration = 2000; // 2 secondes
        const frameDuration = 1000 / 60; // 60fps
        const totalFrames = Math.round(duration / frameDuration);
        let frame = 0;

        const counter = setInterval(() => {
            frame++;
            const progress = frame / totalFrames;
            const current = Math.round(target * progress);
            el.textContent = current.toLocaleString('fr-FR'); // Affiche le nombre avec séparateur de milliers

            if (frame === totalFrames) {
                clearInterval(counter);
                el.textContent = target.toLocaleString('fr-FR');
            }
        }, frameDuration);
    };

    const statsObserver = new IntersectionObserver((entries, observer) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                statNumbers.forEach(numberEl => {
                    countUp(numberEl);
                });
                observer.unobserve(entry.target); // L'animation ne se joue qu'une seule fois
            }
        });
    }, { threshold: 0.5 });

    if (statsSection) {
        statsObserver.observe(statsSection);
    }
});